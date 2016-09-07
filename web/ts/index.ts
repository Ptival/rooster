import * as Completion from "./editor/completion";

import * as Coq85 from "./editor/coq85";
import { CoqDocument } from "./editor/coq-document";
import { setup as setupCoqtopPanel } from "./editor/coqtop-panel";
import { ContextPanel } from "./editor/context-panel";
import { setup as setupDisplayContext } from "./editor/display-context";
import * as Editor from "./editor/editor";
import { isBefore } from "./editor/editor-utils";
import * as FontSize from "./editor/font-size";
import { setup as setupInFlightCounter } from "./editor/in-flight-counter";
import { setup as setupKeybindings } from "./editor/keybindings";
import { setup as setupLayout, rightLayoutName } from "./editor/layout";
import * as ObserveContext from "./editor/observe-context";
import { setup as setupObserveCoqExn } from "./editor/observe-coqexn";
import * as ObserveProcessed from "./editor/observe-processed";
import { setupProgressBar } from "./editor/progress-bar";
import { setup as setupSentenceToDisplay } from "./editor/sentence-to-display";
import * as Stage from "./editor/stage";
import { setupTextCursorPositionUpdate } from "./editor/text-cursor-position";
import { setup as setupToolbar } from "./editor/toolbar";
import * as UnderlineError from "./editor/underline-errors";
import * as UserActions from "./editor/user-actions";
import { setupUserInteractionForwardGoto } from "./editor/user-interaction-forward-goto";

import * as DebugFlags from "./peacoq/debug-flags";
import * as Filters from "./peacoq/filters";
import { PeaCoqGoal } from "./peacoq/goal";
import { emptyContext } from "./peacoq/peacoq";
import { Strictly } from "./peacoq/strictly";
import * as Theme from "./peacoq/theme";

import * as ProofTreeAutomation from "./prooftree/automation";
import { hide as hideProofTreePanel, show as showProofTreePanel } from "./prooftree/panel";
import * as ProofTreePopulating from "./prooftree/populating";
import * as ProofTreeSetup from "./prooftree/setup";

import * as Sertop from "./sertop/sertop";
import * as Command from "./sertop/command";
import * as ControlCommand from "./sertop/control-command";
import * as QueryCommand from "./sertop/query-command";

// import * as Promise from 'bluebird';
// Promise.longStackTraces();
// Promise.onUnhandledRejectionHandled((reason, promise) => {
//   debugger;
// });

const resizeBufferingTime = 250; // milliseconds
const peaCoqGetContextRouteId = 1;

$(document).ready(() => {

  const {
    bottomLayout,
    contextTabs,
    layoutResizeStream,
    rightLayout,
    rightLayoutRenderedStream,
    rightLayoutResizeStream,
    windowResizeStream,
  } = setupLayout();

  const resize$ =
    Rx.Observable.merge(windowResizeStream, layoutResizeStream, rightLayoutResizeStream)
      // only fire once every <resizeBufferingTime> milliseconds
      .bufferWithTime(resizeBufferingTime).filter(a => !_.isEmpty(a));

  const editor = ace.edit("editor");

  const doc: ICoqDocument = new CoqDocument(editor);

  bottomLayout.on({ type: "render", execute: "after" }, () => {
    setupProgressBar(doc);
    bottomLayout.refresh();
  });

  const tabsAreReadyPromise = new Promise(onFulfilled => {
    rightLayoutRenderedStream.take(1).subscribe(() => {
      const tabs: ITabs = <any>{};
      // top panes
      contextTabs.click("pretty");
      doc.contextPanel = new ContextPanel(doc, rightLayoutName);
      // TODO: stream this
      FontSize.update(doc);
      onFulfilled();
    });
  });

  const sentenceToDisplay$ = setupSentenceToDisplay(doc);
  const stmObserve$ = setupDisplayContext(doc, sentenceToDisplay$);

  // For now, if we don't remove the sentences immediately, when the user does
  // Next right after editing somewhere, the Next grabs the sentence after the
  // old tip, because the new tip has not registered yet. As a bad optimization,
  // we drop all sentences beyond the change immediately. This will be incorrect
  // when the user is allowed to edit within blocks.

  // Minor bug: this sends two Cancel commands when the user hits Enter
  // and Ace proceeds to insert a tabulation (these count as two changes)
  // The second Cancel is acknowledged by coqtop with no further action.
  const cancelBecauseEditorChange$: Rx.Observable<StmCancel$> =
    doc.editorChange$
      .flatMap<ISentence<IStage>>(change =>
        doc.getSentenceAtPosition(minPos(change.start, change.end)).caseOf({
          nothing: () => [],
          just: s => [s],
        })
      )
      .do(sRemoved => doc.removeSentences(s => s.sentenceId >= sRemoved.sentenceId))
      .flatMap(s =>
        s.getStateId()
          .caseOf({
            nothing: () => [],
            just: sid => [Rx.Observable.just(new Command.Control(new ControlCommand.StmCancel([sid])))],
          })
      )
      .share();

  Editor.setupMainEditor(doc, editor);

  editor.focus();

  resize$.subscribe(() => onResize(doc));
  resize$.subscribe(() => doc.contextPanel.onResize());

  const toolbarStreams = setupToolbar(doc);
  const shortcutsStreams = setupKeybindings(doc);
  const userActionStreams = UserActions.setup(doc, toolbarStreams, shortcutsStreams);

  userActionStreams.loadedFile$.subscribe(() => doc.contextPanel.clear());

  interface GoToPositions {
    destinationPos: AceAjax.Position;
    lastEditStopPos: AceAjax.Position;
  }
  const [forwardGoTo$, backwardGoTo$] = userActionStreams.goTo$
    // filter out when position is already reached
    .flatMap<GoToPositions>(() => {
      const lastEditStopPos = doc.getLastSentenceStop();
      const destinationPos = doc.editor.getCursorPosition();
      return (
        _.isEqual(lastEditStopPos, destinationPos)
          ? []
          : [{ destinationPos: destinationPos, lastEditStopPos: lastEditStopPos, }]
      );
    })
    // partition on the direction of the goTo
    .partition(o => isBefore(Strictly.Yes, o.lastEditStopPos, o.destinationPos));

  const cancelFromBackwardGoTo$: CommandStream<any> =
    backwardGoTo$
      .flatMap(o => {
        const maybeSentence = doc.getSentenceAtPosition(o.destinationPos);
        return (
          maybeSentence
            .bind(e => e.getStateId())
            .fmap(s => new Command.Control(new ControlCommand.StmCancel([s])))
            .caseOf({
              nothing: () => [],
              just: cmd => [Rx.Observable.just(cmd)],
            })
        );
      })
      .share();

  Coq85.setupSyntaxHovering();
  tabsAreReadyPromise.then(() => Theme.setupTheme(doc));
  Theme.afterChange$.subscribe(() => onResize(doc));
  // These also help with the initial display...
  Theme.afterChange$.subscribe(() => { rightLayout.refresh(); });
  Theme.afterChange$.subscribe(() => { bottomLayout.refresh(); });

  const nextSubject: Rx.ReplaySubject<{}> = new Rx.ReplaySubject(1);
  userActionStreams.next$.subscribe(() => nextSubject.onNext({}));

  const cancelSubject: Rx.ReplaySubject<StateId> = new Rx.ReplaySubject<StateId>(1);

  const sentencesToProcessStream = doc.nextSentence(nextSubject.asObservable());

  const sentenceToCancelBecausePrev$: Rx.Observable<ISentence<IStage>> =
    userActionStreams.prev$
      .flatMap(({}) => {
        if (doc.getSentencesToProcess().length > 0) { return []; }
        return [_.maxBy(doc.getAllSentences(), s => s.sentenceId)];
      })
      .share();

  sentenceToCancelBecausePrev$.subscribe(s => {
    doc.moveCursorToPositionAndCenter(s.startPosition);
  });

  const cancelBecausePrev$: CommandStream<any> =
    sentenceToCancelBecausePrev$
      .flatMap(s =>
        s.getStateId().caseOf({
          nothing: () => [],
          just: sid => [sid],
        })
      )
      .merge(cancelSubject.asObservable())
      .map(sid => Rx.Observable.just(new Command.Control(new ControlCommand.StmCancel([sid]))))
      .share();

  /*
  Will have just(pos) when we are trying to reach some position, and
  nothing() when we are not.
  */
  const forwardGoToSubject: Rx.Subject<Maybe<AceAjax.Position>> = new Rx.Subject<Maybe<AceAjax.Position>>();
  forwardGoTo$.subscribe(o => forwardGoToSubject.onNext(just(o.destinationPos)));

  sentencesToProcessStream.subscribe(e => doc.moveCursorToPositionAndCenter(e.stopPosition));

  const addsToProcess$: CommandStream<ISertop.IControl<ISertop.IControlCommand.IStmAdd>> =
    sentencesToProcessStream
      .map(s => {
        const command = new Command.Control(new ControlCommand.StmAdd({}, s.query, false));
        s.commandTag = just(command.tag);
        return Rx.Observable.just(command);
      })
      .share();

  // TODO: I don't like how I pass queriesObserver to each edit stage, I should
  // improve on this design
  const peaCoqGetContext$ = new Rx.Subject<ISertop.IControl<ISertop.IControlCommand.IStmQuery>>();

  // Here are subjects for observables that react to coqtop output
  const cancelBecauseErrorMsg$: Rx.Subject<CommandStreamItem<any>> = new Rx.Subject<CommandStreamItem<any>>();
  const queryForTacticToTry$: Rx.Subject<CommandStreamItem<any>> = new Rx.Subject<CommandStreamItem<any>>();

  const quitBecauseFileLoaded$: CommandStream<any> =
    userActionStreams.loadedFile$
      .startWith({}) // quit upon loading the webpage
      .map(({}) => Rx.Observable.just(new Command.Control(new ControlCommand.Quit())))
      .share();

  const inputsThatChangeErrorState$: CommandStream<any> =
    Rx.Observable.merge<CommandStreamItem<any>>([
      quitBecauseFileLoaded$,
      addsToProcess$,
      cancelBecauseEditorChange$,
      cancelBecausePrev$,
      cancelFromBackwardGoTo$,
    ]);

  const coqtopInputs$: CommandStream<any> =
    Rx.Observable.merge<CommandStreamItem<any>>([
      inputsThatChangeErrorState$,
      cancelBecauseErrorMsg$,
      stmObserve$,
      peaCoqGetContext$.map(i => Rx.Observable.just(i)),
      queryForTacticToTry$,
    ]);

  // Automated tasks need to stop whenever the user changes the current state
  const stopAutomationRound$: Rx.Observable<{}> =
    Rx.Observable.merge([
      quitBecauseFileLoaded$.map(_ => ({})),
      addsToProcess$.map(_ => ({})),
      cancelBecauseEditorChange$,
      cancelBecausePrev$,
      cancelFromBackwardGoTo$,
    ]);

  doc.editor.completers = [{ getCompletions: Completion.createGetCompletions(doc, stopAutomationRound$, nextSubject) }];

  const flatCoqtopInputs$: Rx.ConnectableObservable<ISertop.ICommand> =
    coqtopInputs$
      // merge sequence of groups of commands into one sequence of commands
      .concatMap(cmds => cmds
      // .do(e => console.log("ELEMENT IN", e))
      // .doOnCompleted(() => console.log("COMPLETED"))
      )
      //  .do(cmd => console.log("ELEMENT OUT", cmd))
      .publish();

  const coqtopOutput$s = Sertop.setupCommunication(flatCoqtopInputs$);
  flatCoqtopInputs$.connect();

  // Shorthands for input streams
  const controlCommand$ = flatCoqtopInputs$.let(Filters.controlCommand);

  const stmAdd$ = controlCommand$.let(Filters.stmAdd);
  const stmAdded$ = coqtopOutput$s.answer$s.stmAdded$;
  const stmCancel$ = controlCommand$.let(Filters.stmCancel);
  const stmEditAt$ = controlCommand$.let(Filters.stmEditAt);

  // Shorthands for output streams
  const completed$ = coqtopOutput$s.answer$s.completed$;
  const error$ = coqtopOutput$s.feedback$s.message$s.error$;
  const notice$ = coqtopOutput$s.feedback$s.message$s.notice$;

  const stmActionsInFlightCounter$ = setupInFlightCounter(stmAdd$, stmCancel$, stmEditAt$, completed$);

  ObserveContext.setup(
    doc,
    peaCoqGetContextRouteId,
    peaCoqGetContext$,
    notice$
  );

  ProofTreeAutomation.setup({
    stmActionsInFlightCounter$,
    completed$,
    doc,
    error$,
    notice$,
    queryForTacticToTry$,
    stmAdded$,
    stopAutomationRound$,
  });

  ProofTreePopulating.setup(doc, doc.tip$);

  stmAdded$.subscribe(a => {
    // console.log("STM ADDED", a);
    const allSentences = doc.getSentencesToProcess();
    const sentence = _(allSentences).find(e => isJust(e.commandTag) && fromJust(e.commandTag) === a.cmdTag);
    if (!sentence) { return; } // this happens for a number of reasons...
    const newStage = new Stage.BeingProcessed(sentence.stage, a.answer.stateId);
    sentence.setStage(newStage);
  });

  const nextBecauseGoTo$ = setupUserInteractionForwardGoto(
    doc,
    forwardGoTo$.map(goto => goto.destinationPos),
    error$
  );

  nextBecauseGoTo$
    .delay(0) // this is needed to set up the feedback loop properly
    .subscribe(() => nextSubject.onNext({}));

  ObserveProcessed.setup(
    doc,
    peaCoqGetContext$,
    coqtopOutput$s.feedback$s.processed$
  );

  const stmCanceledFiltered$ = new Rx.Subject<ISertop.IAnswer<ISertop.IStmCanceled>>();

  // Now that we pre-emptively removed sentences from the view before they are
  // acknowledged by the backend, checking which StmCanceled were caused by
  // PeaCoq's automation is more complex than checking if the removed stateIds
  // match a sentence in the document.
  stmCancel$
    // .filter(c => !c.controlCommand.fromAutomation)
    .flatMap(c =>
      coqtopOutput$s.answer$s.stmCanceled$.filter(e => e.cmdTag === c.tag)
    )
    .subscribe(a => {
      const removedStateIds = a.answer.stateIds;
      stmCanceledFiltered$.onNext(a);
      doc.removeSentencesByStateIds(removedStateIds);
      const tip = _.maxBy(doc.getAllSentences(), s => s.sentenceId);
      doc.setTip(tip ? just(tip) : nothing());
    });

  // NOTE: CoqExn is pretty useless in indicating which command failed
  // Feedback.ErrorMsg gives the failed state ID
  // NOTE2: Except when the command fails wihtout a state ID! For instance
  // if you "Require Import Nonsense." So need both?
  error$.subscribe(e => {
    switch (e.editOrState) {
      case EditOrState.Edit: return;
      case EditOrState.State:
        // We have to send a Cancel message so that the next Add acts on the
        // currently-valid state, rather than on the state that failed
        const cancel = new Command.Control(new ControlCommand.StmCancel([e.editOrStateId]));
        cancelBecauseErrorMsg$.onNext(Rx.Observable.just(cancel));
        break;
      default: debugger;
    }
  });

  // keep this above the subscription that removes edits
  UnderlineError.setup(
    doc,
    error$,
    Rx.Observable.merge([
      inputsThatChangeErrorState$
    ])
  );

  // keep this above the subscription that removes edits
  setupCoqtopPanel(
    doc,
    $(w2ui[rightLayoutName].get("bottom").content),
    error$,
    notice$,
    userActionStreams.loadedFile$
  );

  // This used to be simply:
  // - subscribe to coqExn$
  // - remove sentences whose cmdTag >= exn.cmdTag
  // But this won't work with automation, because sometimes a sentence
  // is created in the middle of an automation round, and some
  // automation sentences will have a low cmdTag and raise a CoqExn.
  // We must track provenance of the CoqExn and only remove sentences
  // when it happened because of user action.

  const stmQuery$ =
    flatCoqtopInputs$
      .let(Filters.controlCommand)
      .let(Filters.stmQuery);

  // keep this under subscribers who need the edit to exist
  setupObserveCoqExn(
    doc,
    coqtopOutput$s.answer$s.coqExn$,
    stmAdd$,
    stmQuery$,
    completed$
  );

  // keep this under subscribers who need the edit to exist
  error$.subscribe(e => {
    switch (e.editOrState) {
      case EditOrState.Edit: return;
      case EditOrState.State:
        const failedStateId = e.editOrStateId;
        const failedSentence = doc.getSentenceByStateId(failedStateId);
        failedSentence.caseOf({
          nothing: () => {
            // This happens when commands fail before producing a state
          },
          just: s => doc.removeSentences(e => e.sentenceId >= s.sentenceId),
        });
        break;
      default: debugger;
    }
  });

  // debugging
  coqtopOutput$s.answer$s.coqExn$
    .filter(e => e.answer.getMessage().indexOf("Anomaly") >= 0)
    .subscribe(e => { debugger; });

  // const editorError$: Rx.Observable<IEditorError> =
  //   coqtopOutput$s.valueFail$
  //     .map(vf => pimpMyError(vf))
  //     .share();
  //
  // editorError$.subscribe(ee =>
  //   Global.coqDocument.removeEditAndFollowingOnes(ee.failedEdit)
  // );
  //
  // new CoqtopPanel(
  //   $(w2ui[rightLayoutName].get("bottom").content),
  //   coqtopOutput$s.feedback$s.errorMsg$,
  //   coqtopOutput$s.message$
  // );

  // editorError$.subscribe(ee => ee.range.fmap(range =>
  //   Global.coqDocument.markError(range)
  // ));

  // editorError$.subscribe(ee =>
  //   // so, apparently we won't receive feedbacks for the edits before this one
  //   // so we need to mark them all processed...
  //   _(Global.coqDocument.getSentencesBeingProcessed())
  //     // ASSUMPTION: state IDs are assigned monotonically
  //     .filter(e => e.stage.stateId < ee.error.stateId)
  //     .each(_ => { debugger; })
  //     .each(e => e.setStage(new Sentence.Processed(e.stage, queriesObserver)))
  // );

  // setupTextCursorPositionUpdate(
  //   Global.coqDocument.edits.editProcessed$,
  //   editorError$,
  //   previousEditToReach$,
  //   editsToProcessStream
  // );

  // coqtopOutput$s.valueGood$s.editAt$
  //   .subscribe(r => {
  //     const processedEdits = Global.coqDocument.getProcessedEdits();
  //     const firstEditAfter =
  //       _(processedEdits).find(e => e.stage.stateId > (<CoqtopInput.EditAt>r.input).stateId);
  //     if (firstEditAfter) {
  //       Global.coqDocument.removeEditAndFollowingOnes(firstEditAfter);
  //     }
  //   });

  // I'm not sure when this happens, for now I'll assume it doesn't
  // coqtopOutput$s.valueGood$s.editAt$
  //   .subscribe(io => {
  //     if (io.output.response.contents.hasOwnProperty("Right")) { throw io; }
  //   });

  // Rx.Observable.empty() // stmCanceled
  //   .subscribe(r => onStmCanceled(
  //     hideProofTreePanel,
  //     r.input.getArgs()
  //   ));

  ProofTreeSetup.setup({
    doc,
    cancelSubject,
    hideProofTreePanel: () => hideProofTreePanel(bottomLayout),
    loadedFile$: userActionStreams.loadedFile$,
    nextSubject,
    resize$,
    sentenceProcessed$: doc.sentenceProcessed$,
    showProofTreePanel: () => showProofTreePanel(bottomLayout),
    stmCanceled$: stmCanceledFiltered$,
  });

  // Debugging:
  doc.editor.setValue(`
    Inductive day : Type :=
    | monday : day
    | tuesday : day
    | wednesday : day
    | thursday : day
    | friday : day
    | saturday : day
    | sunday : day
    .
  `);

});

function updateCoqtopTabs(context: PeaCoqContext) {
  console.log("TODO: updateCoqtopTabs");
  // clearCoqtopTabs(false);
  // if (context.length > 0) {
  //   pretty.div.append(context[0].getHTML());
  //   foreground.setValue(goals.fgGoals[0].toString(), false);
  // }
}

export function onResize(doc: ICoqDocument): void {
  doc.editor.resize();
  doc.getActiveProofTree().fmap(t => {
    const parent = $("#prooftree").parent();
    t.resize(parent.width(), parent.height());
  });
}

function minPos(pos1: AceAjax.Position, pos2: AceAjax.Position): AceAjax.Position {
  if (pos1.row < pos2.row) {
    return pos1;
  }
  if (pos2.row < pos1.row) {
    return pos2;
  }
  if (pos1.column < pos2.column) {
    return pos1;
  }
  return pos2;
}
