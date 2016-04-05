import { EditMarker } from "./edit-marker";
import { ToProcess } from "./edit-stage";
import { Strictly } from "../strictly";

export class Edit {
  document: ICoqDocument;
  previousEdit: Maybe<Edit>;
  query: string;
  stage: IEditStage;

  constructor(doc: ICoqDocument, start: AceAjax.Position, stop: AceAjax.Position, query: string) {
    this.document = doc;
    this.query = query;
    let previous = _(doc.getAllEdits()).last();
    this.previousEdit = previous ? just(previous) : nothing();
    this.stage = new ToProcess(this, new EditMarker(doc, start, stop));
  }

  containsPosition(p: AceAjax.Position): boolean {
    // TODO: I think ace handles this
    return (
      isBefore(Strictly.No, this.getStartPosition(), p)
      && isBefore(Strictly.No, p, this.getStopPosition())
    );
  }

  getStartPosition(): AceAjax.Position { return this.stage.getStartPosition(); }
  getStopPosition(): AceAjax.Position { return this.stage.getStopPosition(); }
  remove(): void { this.stage.remove(); }
}

/**
 * Checks if first argument is strictly before second argument
**/
function isBefore(flag: Strictly, pos1: AceAjax.Position, pos2: AceAjax.Position): boolean {
  if (pos1.row < pos2.row) { return true; }
  if (pos1.row > pos2.row) { return false; }
  switch (flag) {
    case Strictly.Yes: return pos1.column < pos2.column;
    case Strictly.No: return pos1.column <= pos2.column;
  };
}

function isAfter(flag: Strictly, pos1: AceAjax.Position, pos2: AceAjax.Position): boolean {
  if (pos1.row > pos2.row) { return true; }
  if (pos1.row < pos2.row) { return false; }
  switch (flag) {
    case Strictly.Yes: return pos1.column > pos2.column;
    case Strictly.No: return pos1.column >= pos2.column;
  };
}