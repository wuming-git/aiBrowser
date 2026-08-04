/**
 * Core types for DomService (ported from browser-use dom/views.py).
 */

export enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12,
}

export const DEFAULT_INCLUDE_ATTRIBUTES: string[] = [
  'title',
  'type',
  'checked',
  'id',
  'name',
  'role',
  'value',
  'placeholder',
  'data-date-format',
  'alt',
  'aria-label',
  'aria-expanded',
  'data-state',
  'aria-checked',
  'aria-valuemin',
  'aria-valuemax',
  'aria-valuenow',
  'aria-placeholder',
  'pattern',
  'min',
  'max',
  'minlength',
  'maxlength',
  'step',
  'accept',
  'multiple',
  'inputmode',
  'autocomplete',
  'aria-autocomplete',
  'list',
  'data-mask',
  'data-inputmask',
  'data-datepicker',
  'format',
  'expected_format',
  'contenteditable',
  'pseudo',
  'selected',
  'expanded',
  'pressed',
  'disabled',
  'invalid',
  'valuemin',
  'valuemax',
  'valuenow',
  'keyshortcuts',
  'haspopup',
  'multiselectable',
  'required',
  'valuetext',
  'level',
  'busy',
  'live',
  'ax_name',
]

export type DOMRect = {
  x: number
  y: number
  width: number
  height: number
}

export type EnhancedAXProperty = {
  name: string
  value: string | boolean | null
}

export type EnhancedAXNode = {
  axNodeId: string
  ignored: boolean
  role: string | null
  name: string | null
  description: string | null
  properties: EnhancedAXProperty[] | null
  childIds: string[] | null
}

export type EnhancedSnapshotNode = {
  isClickable: boolean | null
  cursorStyle: string | null
  bounds: DOMRect | null
  clientRects: DOMRect | null
  scrollRects: DOMRect | null
  computedStyles: Record<string, string> | null
  paintOrder: number | null
  stackingContexts: number | null
}

export type HiddenElementInfo = {
  tag: string
  text: string
  pages: number
}

export type EnhancedDOMTreeNode = {
  nodeId: number
  backendNodeId: number
  nodeType: NodeType
  nodeName: string
  nodeValue: string
  attributes: Record<string, string>
  isScrollable: boolean | null
  isVisible: boolean | null
  absolutePosition: DOMRect | null
  targetId: string
  frameId: string | null
  sessionId: string | null
  contentDocument: EnhancedDOMTreeNode | null
  shadowRootType: string | null
  shadowRoots: EnhancedDOMTreeNode[] | null
  parentNode: EnhancedDOMTreeNode | null
  childrenNodes: EnhancedDOMTreeNode[] | null
  axNode: EnhancedAXNode | null
  snapshotNode: EnhancedSnapshotNode | null
  hasJsClickListener: boolean
  hiddenElementsInfo: HiddenElementInfo[]
  hasHiddenContent: boolean
  /** Compound control virtual children (mutated by serializer) */
  _compoundChildren?: Array<Record<string, unknown>>

  readonly tagName: string
  readonly childrenAndShadowRoots: EnhancedDOMTreeNode[]
  readonly isActuallyScrollable: boolean
  readonly shouldShowScrollInfo: boolean
  getScrollInfoText(): string
}

export type PropagatingBounds = {
  tag: string
  bounds: DOMRect
  nodeId: number
  depth: number
}

export type SimplifiedNode = {
  originalNode: EnhancedDOMTreeNode
  children: SimplifiedNode[]
  shouldDisplay: boolean
  isInteractive: boolean
  selectorIndex: number | null
  isNew: boolean
  ignoredByPaintOrder: boolean
  excludedByParent: boolean
  isShadowHost: boolean
  isCompoundComponent: boolean
}

export type DOMSelectorMap = Record<number, EnhancedDOMTreeNode>

export type SerializedDOMState = {
  _root: SimplifiedNode | null
  selectorMap: DOMSelectorMap
}

export type TargetAllTrees = {
  snapshot: any
  domTree: any
  axTree: { nodes: any[] }
  devicePixelRatio: number
  cdpTiming: Record<string, number>
  jsClickListenerBackendIds: Set<number> | null
}
