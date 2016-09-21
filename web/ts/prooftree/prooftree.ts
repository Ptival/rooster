import * as d3Hierarchy from "d3-hierarchy"
import * as d3Interpolate from "d3-interpolate"
import * as d3Path from "d3-path"
import * as d3Selection from "d3-selection"
import * as d3Transition from "d3-transition"
import { FakeNode } from "./fakenode"
import { GoalNode } from "./goalnode"
import * as ProofTreeUtils from "./utils"
import { TacticGroupNode } from "./tacticgroupnode"
import { Strictly } from "../peacoq/strictly"
import { debounceAndThrottle } from "../rxjs/operators"

export type HTMLElementSelection = d3Selection.Selection<d3Selection.BaseType, {}, null, never>
export type NodeSelection = d3Selection.Selection<d3Selection.BaseType, IProofTreeNode, null, never>
export type ProofTreeLink = d3Hierarchy.HierarchyLink<IProofTreeNode>
export type LinkSelection = d3Selection.Selection<d3Selection.BaseType, ProofTreeLink, null, never>

function byNodeId(d: IProofTreeNode): string { return d.id }
function byLinkId(d: ProofTreeLink): string { return `${d.source.id}, ${d.target.id}` }

/* Globals to be configured */
let animationDuration = 800
// let diffBlue = "#8888EE"
// let diffGreen = "#88EE88"
// let diffOrange = "#FFB347"
// let diffOpacity = 0.75
// let diffRed = "#EE8888"
let goalBodyPadding = 4
let verticalSpacingBetweenNodes = 10

export class ProofTree implements IProofTree {
  public readonly curNode$: Rx.Subject<IGoalNode>
  public rootNode: IGoalNode
  public tacticWaiting: Maybe<string>
  public xFactor: number
  public yFactor: number

  private anchor: HTMLElementSelection
  private _curNode: IGoalNode
  private descendantsOffset: number
  private paused: boolean
  private svgId: string
  private tactics: () => TacticGroup[]
  private tacticsWorklist: WorklistItem[]
  private hierarchyRoot: d3Hierarchy.HierarchyNode<IProofTreeNode>
  private updateSubject: Rx.Subject<{}>
  private usingKeyboard: boolean /* true until the user uses their mouse */
  private viewportX: number
  private viewportY: number

  private div: HTMLElementSelection
  private svg: HTMLElementSelection
  private viewport: HTMLElementSelection
  private linkLayer: HTMLElementSelection
  private rectLayer: HTMLElementSelection
  private diffLayer: HTMLElementSelection
  private textLayer: HTMLElementSelection
  private tipsLayer: HTMLElementSelection

  constructor(
    public name: string,
    anchor: HTMLElement,
    private width: number,
    private height: number,
    parent: Maybe<ITacticGroupNode>,
    public context: PeaCoqContext,
    public index: number,
    public document: ICoqDocument
  ) {
    width = Math.max(0, width)
    this.width = width
    height = Math.max(0, height)
    this.height = height

    this.anchor = d3Selection.select(anchor)

    this.paused = false
    this.svgId = _.uniqueId()
    this.xFactor = this.width
    this.yFactor = this.height
    this.usingKeyboard = true // true until the user moves their mouse
    this.tacticWaiting = nothing()

    this.rootNode = new GoalNode(this, parent, context, index)

    this._curNode = this.rootNode
    this.curNode$ = new Rx.BehaviorSubject(this.rootNode)

    this.hierarchyRoot = d3Hierarchy.hierarchy(
      this.rootNode,
      (node: IProofTreeNode) => {
        debugger // check if arguments contains more arguments?
        // fake nodes are used to trick the layout engine into spacing
        // childrenless nodes appropriately
        if (node instanceof FakeNode) { return [] }
        let viewChildren = node.getViewChildren()
        // in order to trick d3 into displaying tactics better add fake
        // children to tactic nodes that solve their goal
        if (node instanceof TacticGroupNode && viewChildren.length === 0) {
          return [new FakeNode(this, node)]
        }
        return viewChildren
      }
    )

    debugger // FIXME

    // (
    //   this.rootNode,
    //   (node: IProofTreeNode) => {
    //     debugger // check if arguments contains more arguments?
    //     // fake nodes are used to trick the layout engine into spacing
    //     // childrenless nodes appropriately
    //     if (node instanceof FakeNode) { return [] }
    //     let viewChildren = node.getViewChildren()
    //     // in order to trick d3 into displaying tactics better add fake
    //     // children to tactic nodes that solve their goal
    //     if (node instanceof TacticGroupNode && viewChildren.length === 0) {
    //       return [new FakeNode(this, node)]
    //     }
    //     return viewChildren
    //   })

    // .separation(
    // d => {
    //   // TODO: now that I put fake nodes, still need this?
    //   // TODO: this just won't work, need invisible children
    //   // for tactics without children
    //   return 1 / (1 + (d.depth * d.depth * d.depth))
    // })

    d3Selection.select("body")
      .on("keydown", () => {
        // capture events only if we are in proof mode
        if ($(":focus").length === 0) {
          this.keydownHandler()
        }
      })

    this.div = this.anchor
      .insert("div", ":first-child")
      .attr("id", "pt-" + this.svgId)
      .classed("prooftree", true)
      .style("overflow", "hidden")

    this.svg = this.div
      .insert("svg", ":first-child")
      .classed("svg", true)
      .attr("id", "svg-" + this.svgId)
      // necessary for the height to be exactly what we set
      .attr("display", "block")
      .style("width", this.width + "px")
      .style("height", this.height + "px")
      // also need these as attributes for svg_todataurl
      .attr("width", this.width + "px")
      .attr("height", this.height + "px")
    // .attr("focusable", true)
    // this creates a blue outline that changes the width weirdly
    // .attr("tabindex", 0)
    // for debugging, this is useful
    // .attr("viewBox", "0 -100 1000 400")

    this.viewport =
      this.svg
        .append("g")
        .attr("id", "viewport") // for SVGPan.js
        .attr("class", "viewport")
        .attr(
        "transform",
        "translate(" + this.getGoalWidth() + ", 0)"
        )

    // note: the order of these influence the display
    // from bottom layers
    this.linkLayer = this.viewport.append("g").attr("id", "link-layer")
    this.rectLayer = this.viewport.append("g").attr("id", "rect-layer")
    this.diffLayer = this.viewport.append("g").attr("id", "diff-layer")
    this.textLayer = this.viewport.append("g").attr("id", "text-layer")
    this.tipsLayer = this.viewport.append("g").attr("id", "tips-layer")
    // to top layers

    // if (svgPanEnabled) {
    //   this.svg.insert("script", ":first-child").attr("xlink:href", "SVGPan.js")
    // }

    this.updateSubject = new Rx.Subject()
    Rx.Observable.interval(2000).subscribe(() => this.updateSubject.onNext({}))
    this.updateSubject
      .let(debounceAndThrottle(1000))
      .subscribe(() => this.updateAndWait())

  }

  public cleanup() {
    this.curNode$.onCompleted()
  }

  public getAllGoals(): IGoalNode[] {
    return ([] as IGoalNode[]).concat(
      [this.rootNode],
      this.rootNode.getAllGoalDescendants()
    )
  }

  get curNode(): IGoalNode { return this._curNode }
  set curNode(n: IGoalNode) {
    if (n.id !== this._curNode.id) {
      // debugger
      // console.log("Switching current node to", n)
      this._curNode = n
      n.focus()
      this.curNode$.onNext(n)
    }
  }

  public getGoalWidth() {
    let goalShare = 15 / 20
    return Math.floor(this.width * (goalShare / 2))
  }

  public getTacticWidth() {
    let tacticShare = 4 / 20
    return Math.floor(this.width * (tacticShare / 2))
  }

  public isCurNode(n: IProofTreeNode): boolean { return n.id === this.curNode.id }

  public isCurNodeAncestor(strictly: Strictly, n: IProofTreeNode): boolean {
    let common = ProofTreeUtils.commonAncestor(n, this.curNode)
    let commonAncestorIsNode = common.id === n.id
    switch (strictly) {
      case Strictly.Yes: return commonAncestorIsNode && !this.isCurNode(n)
      case Strictly.No: return commonAncestorIsNode
    }
    throw "ProofTree.isCurNodeAncestor"
  }

  public requestNext(): void {
    this.document.next()
  }

  public resize(width: number, height: number) {
    this.width = Math.floor(width)
    this.height = Math.floor(height)
    this.svg
      .style("width", `${this.width}px`)
      .style("height", `${this.height}px`)
      // also need these as attributes for svg_todataurl
      .attr("width", `${this.width}px`)
      .attr("height", `${this.height}px`)

    this.scheduleUpdate()
  }

  public scheduleUpdate(): void {
    this.updateSubject.onNext({})
  }

  public updateAndWait(): Promise<{}> {
    // console.trace(new Date())
    return new Promise((onFulfilled, onRejected) => {
      this.updatePromise(
        () => {
          // console.log("UPDATE: DONE")
          onFulfilled()
        },
        onRejected
      )
    })
  }

  public xOffset(d: IProofTreeNode): number {
    return - d.getWidth() / 2 // position the center
  }

  public yOffset(d: IProofTreeNode): number {
    let offset = - d.getHeight() / 2 // for the center
    let focusedChild = this.curNode.getFocusedChild()

    // all tactic nodes are shifted such that the current tactic is centered
    // assert(isGoal(this.curNode), "yOffset assumes the current node is a goal!")
    if (this.isCurGoalChild(d)) {
      // assert(focusedChild !== undefined, "yOffset: focusedChild === undefined")
      return offset + (
        ProofTreeUtils.nodeY(fromJust(d.getParent())) - ProofTreeUtils.nodeY(fromJust(focusedChild))
      ) * this.yFactor
    }

    // all goal grandchildren are shifted such that the context line of the
    // current goal and the current suboal align
    if (this.isCurGoalGrandChild(d)) {
      return offset + this.descendantsOffset
    }

    // we center the curNode parent to its focused child
    if (this.isCurNodeParent(d)) {
      if (d instanceof TacticGroupNode) {
        return offset + (
          ProofTreeUtils.nodeY(this.curNode) - ProofTreeUtils.nodeY(d)
        ) * this.yFactor
      } else {
        // This should not happen anymore (should not be a GoalNode)
        debugger
      }
    }

    // the other nodes (current goal and its ancestors) stay where they need
    return offset
  }

  /*
    here we are looking for the descendant which should align with the current
    node. it used to be at the top of the view, now it's centered.
  */
  private computeDescendantsOffset() {
    let curNode = this.curNode

    let centeredDescendant =
      this.curNode.getFocusedChild().caseOf<Maybe<IProofTreeNode>>({
        nothing: () => nothing(),
        just: fc => fc.getFocusedChild().caseOf<Maybe<IProofTreeNode>>({
          nothing: () => just(fc),
          just: (fgc) => just(fgc),
        })
      })

    centeredDescendant.caseOf({
      nothing: () => { this.descendantsOffset = 0 },
      just: d => {
        if (d instanceof GoalNode) {
          // computing the difference in height between the <hr> is not
          // obvious...
          let hrDelta = curNode.html[0].offsetTop - d.html[0].offsetTop
          this.descendantsOffset = (
            this.yFactor * (ProofTreeUtils.nodeY(curNode) - ProofTreeUtils.nodeY(d))
            - (curNode.getHeight() - d.getHeight()) / 2
            + hrDelta
          )
        } else {
          this.descendantsOffset =
            this.yFactor * (ProofTreeUtils.nodeY(curNode) - ProofTreeUtils.nodeY(d))

        }
      }
    })

  }

  private computeXYFactors() {
    let curGoal = this.curNode
    let visibleChildren = _(curGoal.getViewChildren())
    let visibleGrandChildren = _(curGoal.getViewGrandChildren())
    let emptyNodeArray: IProofTreeNode[] = []
    let visibleNodes = _(emptyNodeArray)
    curGoal.getParent().fmap(p => {
      visibleNodes = visibleNodes.concat([p])
    })
    visibleNodes = visibleNodes.concat([curGoal])
    visibleNodes = visibleNodes.concat(visibleChildren.value())
    visibleNodes = visibleNodes.concat(visibleGrandChildren.value())

    // xFactor is now fixed, so that the user experience is more stable
    let rootViewChildren = this.rootNode.getViewChildren()
    if (rootViewChildren.length === 0) {
      this.xFactor = this.width
    } else {
      let xDistance = ProofTreeUtils.nodeX(rootViewChildren[0]) - ProofTreeUtils.nodeX(this.rootNode)
      /* width = 4 * xDistance * xFactor */
      this.xFactor = this.width / (4 * xDistance)
    }

    /*
      we want all visible grand children to be apart from each other
      i.e.
      ∀ a b, yFactor * | a.y - b.y | > a.height/2 + b.height/2 + nodeVSpacing
      we also want all visible children to be apart from each other (especially
      when they don't have their own children to separate them)
    */
    let gcSiblings = _.zip(
      visibleGrandChildren.value(),
      visibleGrandChildren.tail().value()
    )
    gcSiblings.pop() // removes the [last, undefined] pair at the end
    let cSiblings = _.zip(
      visibleChildren.value(),
      visibleChildren.tail().value()
    )
    cSiblings.pop()
    // also, the current node should not overlap its siblings
    let currentSiblings: IProofTreeNode[][] = []
    if (this.curNode instanceof GoalNode && this.curNode.hasParent()) {
      let curNodeSiblings = _(fromJust(this.curNode.getParent()).getViewChildren())
      currentSiblings = _.zip(
        curNodeSiblings.value(),
        curNodeSiblings.tail().value()
      )
      currentSiblings.pop()
    }
    let siblings = _(gcSiblings.concat(cSiblings, currentSiblings))
    // debugger
    let yFactors = siblings
      .map(e => {
        let a = e[0], b = e[1]
        let yDistance = ProofTreeUtils.nodeY(b) - ProofTreeUtils.nodeY(a)
        if (yDistance === 0) {
          debugger
          return 1
        }
        let wantedSpacing = ((a.getHeight() + b.getHeight()) / 2) + verticalSpacingBetweenNodes
        return wantedSpacing / yDistance
      })
      .value()

    this.yFactor = _.isEmpty(yFactors) ? this.height : _.max(yFactors)

    // This has happened many times!!!
    if (!Number.isFinite(this.xFactor)) { debugger }
    if (!Number.isFinite(this.yFactor)) { debugger }
  }

  private getAllNodes(): IProofTreeNode[] { return this.rootNode.getAllDescendants() }

  private getCurrentGoal(): IGoalNode {
    assert(this.curNode instanceof GoalNode, "getCurrentGoal: curNode instanceof GoalNode")
    return this.curNode
  }

  private getFocus() { $(":focus").blur() }

  private getCurrentScale() {
    return (<any>this.svg[0][0]).currentScale
  }

  /*
    getFocusedGoal(): GoalNode {
      let focusedChild = this.curNode.getFocusedChild()
      if (focusedChild !== undefined) {
        //if (focusedChild instanceof GoalNode) { return focusedChild }
        let focusedGrandChild = focusedChild.getFocusedChild()
        if (focusedGrandChild !== undefined) {
          return focusedGrandChild
        }
      }
      return undefined
    }
  */

  private isCurGoal(n: IProofTreeNode): boolean {
    return n.id === this.curNode.id
  }

  private isCurGoalChild(n: IProofTreeNode): boolean {
    return n.hasParentSuchThat(p => this.isCurGoal(p))
  }

  private isCurGoalGrandChild(n: IProofTreeNode): boolean {
    return n.hasParentSuchThat(p => this.isCurGoalChild(p))
  }

  private isCurNodeChild(n: IProofTreeNode): boolean {
    return n.hasParentSuchThat(p => this.isCurNode(p))
  }

  private isCurNodeDescendant(strictly: Strictly, n: IProofTreeNode): boolean {
    let common = ProofTreeUtils.commonAncestor(n, this.curNode)
    let commonAncestorIsCurNode = common.id === this.curNode.id
    switch (strictly) {
      case Strictly.Yes: return commonAncestorIsCurNode && !this.isCurNode(n)
      case Strictly.No: return commonAncestorIsCurNode
    }
    throw "ProofTree.isCurNodeDescendant"
  }

  private isCurNodeGrandChild(n: IProofTreeNode): boolean {
    return n.hasParentSuchThat(p => this.isCurNodeChild(p))
  }

  private isCurNodeParent(n: IProofTreeNode): boolean {
    return this.curNode.hasParentSuchThat(p => p.id === n.id)
  }

  // isCurNodeSibling(n: ProofTreeNode): boolean {
  //   return !this.isCurNode(n) && hasParent(n) && this.isCurNodeParent(n.getParent())
  // }

  private isRootNode(n: IProofTreeNode): boolean {
    return n.id === this.rootNode.id
  }

  private keydownHandler() {
    debugger // how does this work in D3 4.0?
    // const ev: any = d3.event
    // // don't interact while typing
    // if (ev.target.type === "textarea") { return }
    // const curNode = this.curNode
    // const children = curNode.getViewChildren()
    // this.usingKeyboard = true
    // // console.log(d3.event.keyCode)

    // switch (ev.keyCode) {

    //   case 37: // Left
    //     // case 65: // a
    //     ev.preventDefault()
    //     curNode.getParent().caseOf({
    //       nothing: () => {
    //         // when at the root node, undo the last action (usually Proof.)
    //         // onCtrlUp(false)
    //       },
    //       just: parent => {
    //         // asyncLog("LEFT " + nodeString(curNode.parent))
    //         parent.click()
    //       },
    //     })
    //     break

    //   case 39: // Right
    //     // case 68: // d
    //     ev.preventDefault()
    //     curNode.getFocusedChild().fmap(dest => {
    //       // asyncLog("RIGHT " + nodeString(dest))
    //       dest.click()
    //     })
    //     break

    //   //   case 38: // Up
    //   //     //case 87: // w
    //   //     ev.preventDefault()
    //   //     if (ev.shiftKey) {
    //   //       //this.shiftPrevGoal(curNode.getFocusedChild())
    //   //     } else {
    //   //       this.shiftPrevByTacticGroup(curNode)
    //   //     }
    //   //     break
    //   //
    //   //   case 40: // Down
    //   //     //case 83: // s
    //   //     ev.preventDefault()
    //   //     if (ev.shiftKey) {
    //   //       //this.shiftNextGoal(curNode.getFocusedChild())
    //   //     } else {
    //   //       this.shiftNextByTacticGroup(curNode)
    //   //     }
    //   //     break
    //   //
    //   //   case 219: // [
    //   //     var focusedChild = curNode.getFocusedChild()
    //   //     focusedChild.fmap((c) => (<TacticGroupNode>c).shiftPrevInGroup())
    //   //     break
    //   //
    //   //   case 221: // ]
    //   //     var focusedChild = curNode.getFocusedChild()
    //   //     focusedChild.fmap((c) => (<TacticGroupNode>c).shiftNextInGroup())
    //   //     break

    //   default:
    //     console.log("Unhandled event", (d3.event as any).keyCode)
    //     return
    // }

    // // EDIT: now that we integrate the proof tree, it's best to let stuff bubble up
    // // if we haven't returned, we don't want the normal key behavior
    // // d3.event.preventDefault()

  }

  private linkWidth(d: ProofTreeLink): string {
    let src = d.source
    let tgt = d.target
    let thin = "2px"
    let thick = "5px"
    // if the user uses his mouse, highlight the path under hover
    /*
    if (!this.usingKeyboard) {
        if (this.hoveredNode === undefined) {
            return thin
        } else {
            if (this.isCurNode(src)) {
                if (sameNode(tgt, this.hoveredNode)) { return thick }
                else if (!hasParent(this.hoveredNode)) { return thin }
                else if (sameNode(tgt, this.hoveredNode.parent)) {
                    return thick
                }
                else { return thin }
            } else if (this.isCurNodeChild(src)) {
                if (sameNode(tgt, this.hoveredNode)) { return thick }
                else { return thin }
            } else {
                return thin
            }
        }
    }
    */

    let curNode = this.curNode

    // if the user uses his keyboard, highlight the focused path
    // if (curNode instanceof GoalNode) {

    return this.curNode.getFocusedChild().caseOf({
      nothing: () => thin,
      just: (focusedChild) => {
        if (this.isCurNode(src.data) && focusedChild.id === tgt.id) { return thick }
        return focusedChild.getFocusedChild().caseOf({
          nothing: () => thin,
          just: (focusedGrandChild) => {
            return (
              focusedChild.id === src.id && focusedGrandChild.id === tgt.id
                ? thick : thin
            )
          },
        })
      },
    })

    //
    // } else if (curNode instanceof TacticGroupNode) {
    //   let focusedChild = this.curNode.getFocusedChild()
    //   if (focusedChild !== undefined && tgt.id === focusedChild.id) {
    //     return thick
    //   }
    //   return thin
    // } else {
    //   throw this.curNode
    // }

  }

  private onLinkEnter(s: LinkSelection): void {
    s.append("path")
      .classed("link", true)
      .attr("fill", "none")
      .attr("d", currentDiagonal)
    // .style("opacity", 0)

  }

  private onLinkExit(s: LinkSelection): void {
    s.transition()
      .attr("d", d => {
        d.source.parent
        return getHierarchyGoalAncestor(d.source).caseOf<string>({
          nothing: () => currentDiagonal({ source: d.source, target: d.source }),
          just: g => currentDiagonal({ source: g, target: g })
        })
      })
      // .style("opacity", "0")
      .remove()
  }

  private onLinkUpdatePostMerge(s: LinkSelection): void {
    s.transition()
      // .style("opacity", 1)
      .attr("d", d => {
        return destinationDiagonal({ "source": d.source, "target": d.target })
      })
      .attr("stroke-width", this.linkWidth.bind(this))
  }

  private onRectEnter(s: NodeSelection): void {
    s
      .append("rect")
      .classed("goal", d => d instanceof GoalNode)
      .classed("tactic", d => d instanceof TacticGroupNode)
      .attr("x", d => d.currentScaledX)
      .attr("y", d => d.currentScaledY)
      .attr("width", d => d.getWidth())
      .attr("height", d => d.getHeight())
      .attr("rx", d => d instanceof GoalNode ? 0 : 10)
    // .style("opacity", 0)
  }

  private onRectExit(s: NodeSelection): void {
    s.transition()
      .attr("x", d =>
        d.getGoalAncestor().caseOf({
          nothing: () => d.getDestinationScaledX(),
          just: gp => gp.getDestinationScaledX(),
        })
      )
      .attr("y", d =>
        d.getGoalAncestor().caseOf({
          nothing: () => d.getDestinationScaledY(),
          just: gp => gp.getDestinationScaledY(),
        })
      )
      // .style("opacity", "0")
      .remove()
  }

  private onRectUpdatePostMerge(s: NodeSelection): void {
    s
      .classed("currentnode", d => this.isCurNode(d))
      .classed("solved", d => d.isSolved())
      .transition()
      .attr("width", d => d.getWidth())
      .attr("height", d => d.getHeight())
      .attrTween("x", (d, i, a) => {
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledX, d.getDestinationScaledX())
        return t => { return d.currentScaledX = interpolator(t) }
      })
      .attrTween("y", (d, i, a) => {
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledY, d.getDestinationScaledY())
        return t => { return d.currentScaledY = interpolator(t) }
      })
    // .attr("y", d => d.getDestinationScaledY())
    // .style("opacity", 1)
  }

  private onTextEnter(s: NodeSelection): void {
    s
      // .each(d => console.log("enter", d.id))
      .attr("x", d => d.currentScaledX)
      .attr("y", d => d.currentScaledY)
      .attr("width", d => d.getWidth())
      .attr("height", d => d.getHeight())
    // .style("opacity", 0)
  }

  private onTextExit(s: NodeSelection): void {
    s
      .transition()
      .attrTween("x", d => {
        const destinationScaledX = d.getGoalAncestor().caseOf({
          nothing: () => d.getDestinationScaledX(),
          just: gp => gp.getDestinationScaledX(),
        })
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledX, destinationScaledX)
        return t => { return d.currentScaledX = interpolator(t) }
      })
      .attrTween("y", d => {
        const destinationScaledY = d.getGoalAncestor().caseOf({
          nothing: () => d.getDestinationScaledY(),
          just: gp => gp.getDestinationScaledY(),
        })
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledY, destinationScaledY)
        return t => { return d.currentScaledY = interpolator(t) }
      })
      // .style("opacity", "0")
      .remove()
  }

  private onTextUpdatePostMerge(s: NodeSelection): void {
    s
      .each(d => { if (d instanceof TacticGroupNode) { d.updateNode() } })
      .transition()
      // .style("opacity", "1")
      // Note: we use attrTween to be able to update currentScaledX and currentScaledY
      .attrTween("x", (d, i, a) => {
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledX, d.getDestinationScaledX())
        return t => { return d.currentScaledX = interpolator(t) }
      })
      .attrTween("y", (d, i, a) => {
        const interpolator = d3Interpolate.interpolateRound(d.currentScaledY, d.getDestinationScaledY())
        return t => { return d.currentScaledY = interpolator(t) }
      })
      // the width must be updated (when resizing window horizontally)
      .attr("width", d => d.getWidth())
      .attr("height", d => d.getHeight())
      // .style("opacity", 1)
      .on("end", function () { // binds `this`
        // this is in "end" so that it does not trigger before nodes are positioned
        d3Selection.select<d3Selection.BaseType, IProofTreeNode>(this)
          .on("click", d => {
            // asyncLog("CLICK " + nodeString(d))
            d.click()
          })
      })
  }

  private processTactics(): Promise<any> {

    /*
      every time curNode is changed, the tacticsWorklist should be
      flushed, so that [runTactic] can reliably add the results of running
       the tactic to the current node
    */

    let promiseSpark = this.tacticsWorklist.shift()

    if (promiseSpark === undefined) {
      return Promise.resolve()
    }

    return promiseSpark()
      // delay for testing purposes
      // .then(delayPromise(0))
      .then(this.processTactics.bind(this))
      .catch(outputError)

  }

  private refreshTactics(): void {
    // if (focusedOnEditor) { return }

    let self = this
    let curNode = this.curNode

    let tacticsAndGroups = this.tactics()

    /*
      _(this.tactics())
        .groupBy(function(elt) {
        if ($.type(elt) === "string") {
          return "tactics"
        } else {
          return "groups"
        }
      })
        .value()
      
      // TODO: there should be no tactics!
      let groups = tacticsAndGroups.groups
      */

    /*
        let groupSparks = _(tacticsAndGroups)
          .map(function(group) {
          let groupNode: TacticGroupNode = self.findOrCreateGroup(curNode, group.name)
          return (
            _(group.tactics)
              .filter(
              tactic => {
                return (
                  !_(groupNode.tactics)
                    .some(function(node) {
                    return (node.tactic === tactic)
                  })
                  )
              })
              .map(
              tactic => {
                return function() {
                  return self.runTactic(tactic, groupNode)
                }
              })
              .flatten(true)
              .value()
            )
        })
          .flatten<() => Promise<any>>(true)
          .value()
          
        // flushes the worklist and add the new sparks
        this.tacticsWorklist = groupSparks
    */
    // console.log("REPOPULATING TACTICS WORKLIST", this.tacticsWorklist)

    this.processTactics()
  }

  private resetSVGTransform(): void {
    const transform = this.viewport.attr("transform")
    if (transform.length === 0) { return }
    let m = parseSVGTransform(transform)
    if (m.hasOwnProperty("matrix")) {
      m = m.matrix
      this.viewport.attr(
        "transform",
        `matrix(1, ${m[1]}, ${m[2]}, 1, ${m[4]}, ${m[5]})`
      )
    }
  }

  // private runTactic(t: string, groupToAttachTo) {
  //   /*
  //       let self = this

  //       let parentGoal = getClosestGoal(groupToAttachTo)
  //       let parentGoalRepr = goalNodeUnicityRepr(parentGoal)

  //       // if we correctly stored the last response in [parentGoal], we don't need
  //       // to query for status at this moment
  //       let beforeResponse = parentGoal.response

  //       $("#loading-text").text(nbsp + nbsp + "Trying " + t)

  //       return asyncQueryAndUndo(t)
  //         //.then(delayPromise(0))
  //         .then(function(response) {
  //           if (isGood(response)) {

  //             //let unfocusedBefore = getResponseUnfocused(beforeResponse)
  //             //let unfocusedAfter = getResponseUnfocused(response)
  //             let newChild = new Tactic(
  //               t,
  //               groupToAttachTo,
  //               response
  //             )

  //             // only attach the newChild if it produces something
  //             // unique from existing children
  //             let newChildRepr = tacticUnicityRepr(newChild)

  //             let resultAlreadyExists =
  //               _(parentGoal.getTactics()).some(function(t) {
  //                 return t.tactic === newChild.tactic
  //                 //return (tacticUnicityRepr(t) === newChildRepr)
  //               })

  //             let tacticIsUseless =
  //               (newChild.goals.length === 1)
  //               && (goalNodeUnicityRepr(newChild.goals[0])
  //                 === parentGoalRepr)

  //             if (!resultAlreadyExists && !tacticIsUseless) {
  //               groupToAttachTo.addTactic(newChild)
  //               self.update()
  //             }

  //           } else {

  //             //console.log("Bad response for", t, response)

  //           }

  //         })
  //         .catch(outputError)
  //   */
  // }

  private shiftNextByTacticGroup(n: IGoalNode): void {
    if (this.paused) { return }
    if (n.isSolved()) { return }
    let viewChildren = n.getViewChildren()
    if (n.tacticIndex + 1 < viewChildren.length) {
      n.tacticIndex++
      // asyncLog("DOWNGROUP " + nodeString(viewChildren[n.tacticIndex]))
      this.scheduleUpdate()
    }
  }

  private shiftPrevByTacticGroup(n: IGoalNode): void {
    if (this.paused) { return }
    if (n.isSolved()) { return }
    if (n.tacticIndex > 0) {
      n.tacticIndex--
      // asyncLog("UPGROUP " + nodeString(n.getViewChildren()[n.tacticIndex]))
      this.scheduleUpdate()
    }
  }

  private updatePromise<T>(onFulfilled: () => void, onRejected: () => void): void {
    let curNode = this.curNode

    this.resetSVGTransform() // cancel view transformations

    const allNodes = d3Hierarchy.tree<IProofTreeNode>()(this.hierarchyRoot).descendants()
    const allLinks = d3Hierarchy.tree<IProofTreeNode>()(this.hierarchyRoot).links()

    // now remove all fake nodes
    const nodes = _(allNodes)
      .filter(node => !(node instanceof FakeNode))
      .value()

    const links = _(allLinks)
      .filter(link => !(link.source instanceof FakeNode || link.target instanceof FakeNode))
      .value()

    const nodeArray = nodes.entries

    // we build the foreignObject first, as its dimensions will guide the others
    let textSelection: NodeSelection = this.textLayer
      .selectAll<d3Selection.BaseType, IProofTreeNode>(function () { // binds `this`
        return (this as Element).getElementsByTagName("foreignObject")
      })
      .data<IProofTreeNode>([], d => d.id)

    // Here we need select({}) because d3 transitions are exclusive and
    // without it, concurrent selections will not each call their "end"
    // callback.
    // See. https://bl.ocks.org/mbostock/5348789
    d3Selection.select({} as any)
      .transition()
      .duration(animationDuration)
      .each(() => {

        let textEnter = textSelection.enter().append("foreignObject")
        let rectSelection = this.rectLayer.selectAll("rect").data<IProofTreeNode>(nodes.map(n => n.data), byNodeId)
        let linkSelection = this.linkLayer.selectAll("path").data<ProofTreeLink>(links, byLinkId)

        /*
        Here, we must rely on the DOM to compute the height of nodes, so
        that we can position them accordingly. However, the height is
        dictated by how the HTML will render for the given width of the
        nodes. Therefore, we must initially include the HTML within the
        yet-to-be-placed nodes, and we must set their width so that the
        renderer computes their height.
  
        Once nodes have a height, we can query it, compute the zooming
        and translating factors, offset the descendant nodes to center
        the focused one, and start positioning nodes.
        */

        textEnter
          .append("xhtml:body")
          .each(function (d) { // binds `this`
            let body = d3Selection.select(this as Element).node()
            d.setHTMLElement(<HTMLElement><any>body)
            if (d instanceof GoalNode) { $(body).append(d.html) }
            if (d instanceof TacticGroupNode) { d.updateNode() }
            // $(body).prepend(d.id)
          })
        textEnter.attr("width", d => d.getWidth())

        // nodes now have a size, we can compute zooming factors
        this.computeXYFactors()
        // compute how much descendants must be moved to center current
        this.computeDescendantsOffset()

        this.onTextEnter(textEnter)
        this.onRectEnter(rectSelection.enter())
        this.onLinkEnter(linkSelection.enter())

        this.onRectUpdatePostMerge(rectSelection)
        this.onTextUpdatePostMerge(textSelection)

        this.onLinkUpdatePostMerge(linkSelection)

        this.onTextExit(textSelection.exit<IProofTreeNode>())
        this.onRectExit(rectSelection.exit<IProofTreeNode>())
        this.onLinkExit(linkSelection.exit<ProofTreeLink>())

        this.viewportX = - (
          curNode.getParent().caseOf({
            nothing: () => curNode.getDestinationScaledX(),
            just: p => p.getDestinationScaledX(),
          })
        )

        this.viewportY = - (
          curNode.getDestinationScaledY()
          + curNode.getHeight() / 2
          - this.height / 2
        )

        this.viewport
          .transition()
          .attr(
          "transform",
          "translate(" + this.viewportX + ", " + this.viewportY + ")"
          )

      })
      .on("end", onFulfilled)

  }

}

// function mkDiagonal(
//   cL: (xy: XY) => XY,
//   cR: (xy: XY) => XY
// ): d3.svg.Diagonal<d3.svg.diagonal.Link<d3.svg.diagonal.Node>, d3.svg.diagonal.Node> {
//   return (
//     d3.svg
//       .diagonal()
//       .source((d: ProofTreeLink, i: number) => {
//         if (!Number.isFinite(d.source.x)) { debugger }
//         if (!Number.isFinite(d.source.y)) { debugger }
//         const centerRight = cR(d.source)
//         if (!Number.isFinite(centerRight.x)) { debugger }
//         if (!Number.isFinite(centerRight.y)) { debugger }
//         return ProofTreeUtils.swapXY(centerRight)
//       })
//       .target((d: ProofTreeLink, i: number) => {
//         if (!Number.isFinite(d.target.x)) { debugger }
//         if (!Number.isFinite(d.target.y)) { debugger }
//         // console.log("target", ProofTreeUtils.swapXY(cR(d.source)))
//         return ProofTreeUtils.swapXY(cL(d.target))
//       })
//       .projection(d => [d.y, d.x])
//   )
// }

// let currentDiagonal = mkDiagonal(ProofTreeUtils.currentCenterLeft, ProofTreeUtils.currentCenterRight)
// let destinationDiagonal = mkDiagonal(ProofTreeUtils.destinationCenterLeft, ProofTreeUtils.destinationCenterRight)

function mkDiagonal(
  cL: (xy: XY) => XY,
  cR: (xy: XY) => XY
): (d: d3Hierarchy.HierarchyLink<IProofTreeNode>) => string {
  return d => {
    const srcNode = d.source.data
    const tgtNode = d.target.data
    const src = ProofTreeUtils.swapXY(cR(srcNode))
    const tgt = ProofTreeUtils.swapXY(cL(tgtNode))
    const path = d3Path.path()
    path.moveTo(src.x, src.y)
    const midX = Math.floor((src.x + tgt.x) / 2)
    // const midY = Math.floor((src.y + tgt.y) / 2)
    path.bezierCurveTo(midX, src.y, midX, tgt.y, tgt.x, tgt.y)
    return path.toString()
  }
}

const currentDiagonal = mkDiagonal(ProofTreeUtils.currentCenterLeft, ProofTreeUtils.currentCenterRight)
const destinationDiagonal = mkDiagonal(ProofTreeUtils.destinationCenterLeft, ProofTreeUtils.destinationCenterRight)

function getHierarchyGoalAncestor(d: d3Hierarchy.HierarchyNode<IProofTreeNode>): Maybe<d3Hierarchy.HierarchyNode<IGoalNode>> {
  if (d.parent === null) { return nothing() }
  if (d.parent.data instanceof GoalNode) { return just(d.parent) }
  return getHierarchyGoalAncestor(d.parent)
}
