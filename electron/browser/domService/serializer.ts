// Serializes enhanced DOM trees to string format for LLM consumption

import type {
	EnhancedDOMTreeNode,
	SimplifiedNode,
	SerializedDOMState,
	DOMRect,
	PropagatingBounds,
} from './types'
import { NodeType, DEFAULT_INCLUDE_ATTRIBUTES } from './types'
import { isInteractive } from './clickable'
import { PaintOrderRemover } from './paintOrder'
import { capTextLength } from './utils'

const DISABLED_ELEMENTS = new Set(['style', 'script', 'head', 'meta', 'link', 'title'])

/** SVG child elements to skip (decorative only, no interaction value) */
const SVG_ELEMENTS = new Set([
	'path',
	'rect',
	'g',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'use',
	'defs',
	'clipPath',
	'mask',
	'pattern',
	'image',
	'text',
	'tspan',
])

type DOMSelectorMap = Record<number, EnhancedDOMTreeNode>

interface CompoundChildInfo {
	role: string
	name: string
	valuemin: number | null
	valuemax: number | null
	valuenow: number | string | null
	options_count?: number
	first_options?: string[]
	format_hint?: string
}

interface SelectOptionsInfo {
	count: number
	first_options: string[]
	format_hint: string | null
}

function createSimplifiedNode(
	originalNode: EnhancedDOMTreeNode,
	children: SimplifiedNode[] = [],
	extras: Partial<SimplifiedNode> = {},
): SimplifiedNode {
	return {
		originalNode,
		children,
		shouldDisplay: true,
		isInteractive: false,
		selectorIndex: null,
		isNew: false,
		ignoredByPaintOrder: false,
		excludedByParent: false,
		isShadowHost: false,
		isCompoundComponent: false,
		...extras,
	} as SimplifiedNode
}

function getChildren(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
	return node.childrenNodes ?? []
}

function getCompoundChildren(node: EnhancedDOMTreeNode): CompoundChildInfo[] {
	const n = node as EnhancedDOMTreeNode & { _compoundChildren?: CompoundChildInfo[] }
	if (!n._compoundChildren) {
		n._compoundChildren = []
	}
	return n._compoundChildren
}

/**
 * Export helper mirroring SerializedDOMState.llm_representation.
 */
export function llmRepresentation(
	state: SerializedDOMState,
	includeAttributes?: string[],
): string {
	if (!state._root) {
		return 'Empty DOM tree (you might have to wait for the page to load)'
	}
	const attrs = includeAttributes ?? DEFAULT_INCLUDE_ATTRIBUTES
	return DOMTreeSerializer.serializeTree(state._root, attrs)
}

export class DOMTreeSerializer {
	/** Configuration - elements that propagate bounds to their children */
	static PROPAGATING_ELEMENTS: Array<{ tag: string; role: string | null }> = [
		{ tag: 'a', role: null }, // Any <a> tag
		{ tag: 'button', role: null }, // Any <button> tag
		{ tag: 'div', role: 'button' }, // <div role="button">
		{ tag: 'div', role: 'combobox' }, // <div role="combobox"> - dropdowns/selects
		{ tag: 'span', role: 'button' }, // <span role="button">
		{ tag: 'span', role: 'combobox' }, // <span role="combobox">
		{ tag: 'input', role: 'combobox' }, // <input role="combobox"> - autocomplete inputs
		{ tag: 'input', role: 'combobox' }, // <input type="text"> - text inputs with suggestions
	]

	static DEFAULT_CONTAINMENT_THRESHOLD = 0.99 // 99% containment by default

	rootNode: EnhancedDOMTreeNode
	private _interactiveCounter = 1
	private _selectorMap: DOMSelectorMap = {}
	private _previousCachedSelectorMap: DOMSelectorMap | null
	private _previousNodeIds: Set<string>
	timingInfo: Record<string, number> = {}
	private _clickableCache: Map<string, boolean> = new Map()
	private _reservedBackendNodeIds: Set<number> = new Set()
	private _nextSyntheticIndex = 1
	enableBboxFiltering: boolean
	containmentThreshold: number
	paintOrderFiltering: boolean
	sessionId: string | null
	private _semanticGroups: unknown[] = []

	constructor(
		rootNode: EnhancedDOMTreeNode,
		previousCachedState: SerializedDOMState | null = null,
		enableBboxFiltering = true,
		containmentThreshold: number | null = null,
		paintOrderFiltering = true,
		sessionId: string | null = null,
	) {
		this.rootNode = rootNode
		this._interactiveCounter = 1
		this._selectorMap = {}
		this._previousCachedSelectorMap = previousCachedState?.selectorMap ?? null
		this._previousNodeIds = new Set()
		if (this._previousCachedSelectorMap) {
			for (const previousNode of Object.values(this._previousCachedSelectorMap)) {
				this._previousNodeIds.add(
					`${previousNode.sessionId != null ? String(previousNode.sessionId) : 'null'}|${previousNode.backendNodeId}`,
				)
			}
		}
		this.timingInfo = {}
		this._clickableCache = new Map()
		this._reservedBackendNodeIds = new Set()
		this._nextSyntheticIndex = 1
		this.enableBboxFiltering = enableBboxFiltering
		this.containmentThreshold = containmentThreshold ?? DOMTreeSerializer.DEFAULT_CONTAINMENT_THRESHOLD
		this.paintOrderFiltering = paintOrderFiltering
		this.sessionId = sessionId
	}

	private _safeParseNumber(valueStr: string, defaultValue: number): number {
		const n = Number(valueStr)
		return Number.isFinite(n) ? n : defaultValue
	}

	private _safeParseOptionalNumber(valueStr: string | null | undefined): number | null {
		if (!valueStr) {
			return null
		}
		const n = Number(valueStr)
		return Number.isFinite(n) ? n : null
	}

	serializeAccessibleElements(): [SerializedDOMState, Record<string, number>] {
		const startTotal = Date.now() / 1000

		// Reset state
		this._interactiveCounter = 1
		this._selectorMap = {}
		this._semanticGroups = []
		this._clickableCache = new Map()
		this._reservedBackendNodeIds = new Set()
		this._nextSyntheticIndex = 1

		// Step 1: Create simplified tree (includes clickable element detection)
		const startStep1 = Date.now() / 1000
		const simplifiedTree = this._createSimplifiedTree(this.rootNode)
		const endStep1 = Date.now() / 1000
		this.timingInfo['create_simplified_tree'] = endStep1 - startStep1

		// Step 2: Remove elements based on paint order
		const startPaint = Date.now() / 1000
		if (this.paintOrderFiltering && simplifiedTree) {
			new PaintOrderRemover(simplifiedTree).calculatePaintOrder()
		}
		const endPaint = Date.now() / 1000
		this.timingInfo['calculate_paint_order'] = endPaint - startPaint

		// Step 3: Optimize tree (remove unnecessary parents)
		const startStep2 = Date.now() / 1000
		const optimizedTree = this._optimizeTree(simplifiedTree)
		const endStep2 = Date.now() / 1000
		this.timingInfo['optimize_tree'] = endStep2 - startStep2

		// Step 3: Apply bounding box filtering
		let filteredTree: SimplifiedNode | null
		if (this.enableBboxFiltering && optimizedTree) {
			const startBbox = Date.now() / 1000
			filteredTree = this._applyBoundingBoxFiltering(optimizedTree)
			const endBbox = Date.now() / 1000
			this.timingInfo['bbox_filtering'] = endBbox - startBbox
		} else {
			filteredTree = optimizedTree
		}

		// Step 4: Assign interactive indices to clickable elements
		const startStep4 = Date.now() / 1000
		this._reserveBackendNodeIds(filteredTree)
		this._assignInteractiveIndicesAndMarkNewNodes(filteredTree)
		const endStep4 = Date.now() / 1000
		this.timingInfo['assign_interactive_indices'] = endStep4 - startStep4

		const endTotal = Date.now() / 1000
		this.timingInfo['serialize_accessible_elements_total'] = endTotal - startTotal

		const state = {
			_root: filteredTree,
			selectorMap: this._selectorMap,
		} as SerializedDOMState

		return [state, this.timingInfo]
	}

	private _addCompoundComponents(simplified: SimplifiedNode, node: EnhancedDOMTreeNode): void {
		/** Enhance compound controls with information from their child components. */
		// Only process elements that might have compound components
		if (!['input', 'select', 'details', 'audio', 'video'].includes(node.tagName)) {
			return
		}

		// For input elements, check for compound input types
		if (node.tagName === 'input') {
			if (
				!node.attributes ||
				![
					'date',
					'time',
					'datetime-local',
					'month',
					'week',
					'range',
					'number',
					'color',
					'file',
				].includes(node.attributes['type'] ?? '')
			) {
				return
			}
		} else if (!node.axNode || !node.axNode.childIds) {
			// For other elements, check if they have AX child indicators
			return
		}

		const elementType = node.tagName
		const inputType = node.attributes ? (node.attributes['type'] ?? '') : ''
		const compoundChildren = getCompoundChildren(node)

		if (elementType === 'input') {
			// NOTE: For date/time inputs, we DON'T add compound components because:
			// 1. They confuse the model (seeing "Day, Month, Year" suggests DD.MM.YYYY format)
			// 2. HTML5 date/time inputs ALWAYS require ISO format (YYYY-MM-DD, HH:MM, etc.)
			// 3. The placeholder attribute clearly shows the required format
			// 4. These inputs use direct value assignment, not sequential typing
			if (['date', 'time', 'datetime-local', 'month', 'week'].includes(inputType)) {
				// Skip compound components for date/time inputs - format is shown in placeholder
			} else if (inputType === 'range') {
				const minVal = node.attributes?.['min'] ?? '0'
				const maxVal = node.attributes?.['max'] ?? '100'

				compoundChildren.push({
					role: 'slider',
					name: 'Value',
					valuemin: this._safeParseNumber(minVal, 0.0),
					valuemax: this._safeParseNumber(maxVal, 100.0),
					valuenow: null,
				})
				simplified.isCompoundComponent = true
			} else if (inputType === 'number') {
				const minVal = node.attributes?.['min'] ?? null
				const maxVal = node.attributes?.['max'] ?? null

				compoundChildren.push(
					{ role: 'button', name: 'Increment', valuemin: null, valuemax: null, valuenow: null },
					{ role: 'button', name: 'Decrement', valuemin: null, valuemax: null, valuenow: null },
					{
						role: 'textbox',
						name: 'Value',
						valuemin: this._safeParseOptionalNumber(minVal),
						valuemax: this._safeParseOptionalNumber(maxVal),
						valuenow: null,
					},
				)
				simplified.isCompoundComponent = true
			} else if (inputType === 'color') {
				compoundChildren.push(
					{ role: 'textbox', name: 'Hex Value', valuemin: null, valuemax: null, valuenow: null },
					{ role: 'button', name: 'Color Picker', valuemin: null, valuemax: null, valuenow: null },
				)
				simplified.isCompoundComponent = true
			} else if (inputType === 'file') {
				const multiple = node.attributes ? 'multiple' in node.attributes : false

				// Extract current file selection state from AX tree
				let currentValue: string | null = 'None' // Default to explicit "None" string for clarity
				if (node.axNode?.properties) {
					for (const prop of node.axNode.properties) {
						// Try valuetext first (human-readable display like "file.pdf")
						if (prop.name === 'valuetext' && prop.value) {
							const valueStr = String(prop.value).trim()
							if (valueStr && !['', 'no file chosen', 'no file selected'].includes(valueStr.toLowerCase())) {
								currentValue = valueStr
							}
							break
						} else if (prop.name === 'value' && prop.value) {
							const valueStr = String(prop.value).trim()
							if (valueStr) {
								// For file inputs, value might be a full path - extract just filename
								if (valueStr.includes('\\')) {
									currentValue = valueStr.split('\\').pop() ?? valueStr
								} else if (valueStr.includes('/')) {
									currentValue = valueStr.split('/').pop() ?? valueStr
								} else {
									currentValue = valueStr
								}
								break
							}
						}
					}
				}

				compoundChildren.push(
					{ role: 'button', name: 'Browse Files', valuemin: null, valuemax: null, valuenow: null },
					{
						role: 'textbox',
						name: `${multiple ? 'Files' : 'File'} Selected`,
						valuemin: null,
						valuemax: null,
						valuenow: currentValue, // Always shows state: filename or "None"
					},
				)
				simplified.isCompoundComponent = true
			}
		} else if (elementType === 'select') {
			const baseComponents: CompoundChildInfo[] = [
				{ role: 'button', name: 'Dropdown Toggle', valuemin: null, valuemax: null, valuenow: null },
			]

			const optionsInfo = this._extractSelectOptions(node)
			if (optionsInfo) {
				const optionsComponent: CompoundChildInfo = {
					role: 'listbox',
					name: 'Options',
					valuemin: null,
					valuemax: null,
					valuenow: null,
					options_count: optionsInfo.count,
					first_options: optionsInfo.first_options,
				}
				if (optionsInfo.format_hint) {
					optionsComponent.format_hint = optionsInfo.format_hint
				}
				baseComponents.push(optionsComponent)
			} else {
				baseComponents.push({
					role: 'listbox',
					name: 'Options',
					valuemin: null,
					valuemax: null,
					valuenow: null,
				})
			}

			compoundChildren.push(...baseComponents)
			simplified.isCompoundComponent = true
		} else if (elementType === 'details') {
			compoundChildren.push(
				{ role: 'button', name: 'Toggle Disclosure', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'region', name: 'Content Area', valuemin: null, valuemax: null, valuenow: null },
			)
			simplified.isCompoundComponent = true
		} else if (elementType === 'audio') {
			compoundChildren.push(
				{ role: 'button', name: 'Play/Pause', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'button', name: 'Mute', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100, valuenow: null },
			)
			simplified.isCompoundComponent = true
		} else if (elementType === 'video') {
			compoundChildren.push(
				{ role: 'button', name: 'Play/Pause', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'button', name: 'Mute', valuemin: null, valuemax: null, valuenow: null },
				{ role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100, valuenow: null },
				{ role: 'button', name: 'Fullscreen', valuemin: null, valuemax: null, valuenow: null },
			)
			simplified.isCompoundComponent = true
		}
	}

	private _extractSelectOptions(selectNode: EnhancedDOMTreeNode): SelectOptionsInfo | null {
		const children = getChildren(selectNode)
		if (!children.length) {
			return null
		}

		const options: Array<{ text: string; value: string }> = []
		const optionValues: string[] = []

		const getDirectTextContent = (n: EnhancedDOMTreeNode): string => {
			let text = ''
			for (const child of getChildren(n)) {
				if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
					text += child.nodeValue.trim() + ' '
				}
			}
			return text.trim()
		}

		const extractOptionsRecursive = (node: EnhancedDOMTreeNode): void => {
			const tag = node.tagName.toLowerCase()
			if (tag === 'option') {
				let optionText = ''
				let optionValue = ''

				if (node.attributes && 'value' in node.attributes) {
					optionValue = String(node.attributes['value']).trim()
				}

				optionText = getDirectTextContent(node)

				if (!optionValue && optionText) {
					optionValue = optionText
				}

				if (optionText || optionValue) {
					options.push({ text: optionText, value: optionValue })
					optionValues.push(optionValue)
				}
			} else if (tag === 'optgroup') {
				for (const child of getChildren(node)) {
					extractOptionsRecursive(child)
				}
			} else {
				for (const child of getChildren(node)) {
					extractOptionsRecursive(child)
				}
			}
		}

		for (const child of children) {
			extractOptionsRecursive(child)
		}

		if (!options.length) {
			return null
		}

		const firstOptions: string[] = []
		for (const option of options.slice(0, 4)) {
			const displayText = option.text ? option.text : option.value
			if (displayText) {
				const text = displayText.slice(0, 30) + (displayText.length > 30 ? '...' : '')
				firstOptions.push(text)
			}
		}

		if (options.length > 4) {
			firstOptions.push(`... ${options.length - 4} more options...`)
		}

		let formatHint: string | null = null
		if (optionValues.length >= 2) {
			const sample = optionValues.slice(0, 5).filter((val) => val)
			if (sample.length && sample.every((val) => /^\d+$/.test(val))) {
				formatHint = 'numeric'
			} else if (sample.length && sample.every((val) => val.length === 2 && val === val.toUpperCase() && /^[A-Z]+$/.test(val))) {
				formatHint = 'country/state codes'
			} else if (sample.length && sample.every((val) => val.includes('/') || val.includes('-'))) {
				formatHint = 'date/path format'
			} else if (sample.some((val) => val.includes('@'))) {
				formatHint = 'email addresses'
			}
		}

		return { count: options.length, first_options: firstOptions, format_hint: formatHint }
	}

	private _isInteractiveCached(node: EnhancedDOMTreeNode): boolean {
		// CDP node IDs are scoped to a session and can be reused by unrelated
		// elements in cross-origin iframe targets.
		const cacheKey = `${node.sessionId != null ? String(node.sessionId) : 'null'}|${node.nodeId}`
		if (!this._clickableCache.has(cacheKey)) {
			const startTime = Date.now() / 1000
			const result = isInteractive(node)
			const endTime = Date.now() / 1000

			if (!('clickable_detection_time' in this.timingInfo)) {
				this.timingInfo['clickable_detection_time'] = 0
			}
			this.timingInfo['clickable_detection_time'] += endTime - startTime

			this._clickableCache.set(cacheKey, result)
		}

		return this._clickableCache.get(cacheKey)!
	}

	private _createSimplifiedTree(node: EnhancedDOMTreeNode, depth = 0): SimplifiedNode | null {
		if (node.nodeType === NodeType.DOCUMENT_NODE) {
			// for all children including shadow roots
			for (const child of node.childrenAndShadowRoots) {
				const simplifiedChild = this._createSimplifiedTree(child, depth + 1)
				if (simplifiedChild) {
					return simplifiedChild
				}
			}
			return null
		}

		if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// ENHANCED shadow DOM processing - always include shadow content
			const simplified = createSimplifiedNode(node, [])
			for (const child of node.childrenAndShadowRoots) {
				const simplifiedChild = this._createSimplifiedTree(child, depth + 1)
				if (simplifiedChild) {
					simplified.children.push(simplifiedChild)
				}
			}

			// Always return shadow DOM fragments, even if children seem empty
			// Shadow DOM often contains the actual interactive content in SPAs
			return simplified.children.length ? simplified : createSimplifiedNode(node, [])
		} else if (node.nodeType === NodeType.ELEMENT_NODE) {
			// Skip non-content elements
			if (DISABLED_ELEMENTS.has(node.nodeName.toLowerCase())) {
				return null
			}

			// Skip SVG child elements entirely (path, rect, g, circle, etc.)
			if (SVG_ELEMENTS.has(node.nodeName.toLowerCase())) {
				return null
			}

			const attributes = node.attributes || {}
			// Check for session-specific exclude attribute first, then fall back to legacy attribute
			let excludeAttr: string | undefined
			if (this.sessionId) {
				const sessionSpecificAttr = `data-browser-use-exclude-${this.sessionId}`
				excludeAttr = attributes[sessionSpecificAttr]
			}
			// Fall back to legacy attribute if session-specific not found
			if (!excludeAttr) {
				excludeAttr = attributes['data-browser-use-exclude']
			}
			if (typeof excludeAttr === 'string' && excludeAttr.toLowerCase() === 'true') {
				return null
			}

			if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
				if (node.contentDocument) {
					const simplified = createSimplifiedNode(node, [])
					for (const child of node.contentDocument.childrenNodes || []) {
						const simplifiedChild = this._createSimplifiedTree(child, depth + 1)
						if (simplifiedChild !== null) {
							simplified.children.push(simplifiedChild)
						}
					}
					return simplified
				}
			}

			let isVisible = !!node.isVisible
			const isScrollable = !!node.isActuallyScrollable
			const hasShadowContent = node.childrenAndShadowRoots.length > 0

			// ENHANCED SHADOW DOM DETECTION: Include shadow hosts even if not visible
			const isShadowHost = node.childrenAndShadowRoots.some(
				(child) => child.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE,
			)

			// Override visibility for elements with validation attributes
			if (!isVisible && node.attributes) {
				const hasValidationAttrs = Object.keys(node.attributes).some(
					(attr) => attr.startsWith('aria-') || attr.startsWith('pseudo'),
				)
				if (hasValidationAttrs) {
					isVisible = true // Force visibility for validation elements
				}
			}

			// EXCEPTION: File inputs are often hidden with opacity:0 but are still functional
			// Bootstrap and other frameworks use this pattern with custom-styled file pickers
			const isFileInput =
				!!node.tagName &&
				node.tagName.toLowerCase() === 'input' &&
				!!node.attributes &&
				node.attributes['type'] === 'file'
			if (!isVisible && isFileInput) {
				isVisible = true // Force visibility for file inputs
			}

			// Include if visible, scrollable, has children, or is shadow host
			if (isVisible || isScrollable || hasShadowContent || isShadowHost) {
				const simplified = createSimplifiedNode(node, [], { isShadowHost })

				// Process ALL children including shadow roots with enhanced logging
				for (const child of node.childrenAndShadowRoots) {
					const simplifiedChild = this._createSimplifiedTree(child, depth + 1)
					if (simplifiedChild) {
						simplified.children.push(simplifiedChild)
					}
				}

				// COMPOUND CONTROL PROCESSING: Add virtual components for compound controls
				this._addCompoundComponents(simplified, node)

				// SHADOW DOM SPECIAL CASE: Always include shadow hosts even if not visible
				// Many SPA frameworks (React, Vue) render content in shadow DOM
				if (isShadowHost && simplified.children.length) {
					return simplified
				}

				// Return if meaningful or has meaningful children
				if (isVisible || isScrollable || simplified.children.length) {
					return simplified
				}
			}
		} else if (node.nodeType === NodeType.TEXT_NODE) {
			// Include meaningful text nodes
			const isVisible = !!(node.snapshotNode && node.isVisible)
			if (isVisible && node.nodeValue && node.nodeValue.trim() && node.nodeValue.trim().length > 1) {
				return createSimplifiedNode(node, [])
			}
		}

		return null
	}

	private _optimizeTree(node: SimplifiedNode | null): SimplifiedNode | null {
		if (!node) {
			return null
		}

		// Process children
		const optimizedChildren: SimplifiedNode[] = []
		for (const child of node.children) {
			const optimizedChild = this._optimizeTree(child)
			if (optimizedChild) {
				optimizedChildren.push(optimizedChild)
			}
		}

		node.children = optimizedChildren

		// Keep meaningful nodes
		const isVisible = !!(node.originalNode.snapshotNode && node.originalNode.isVisible)

		// EXCEPTION: File inputs are often hidden with opacity:0 but are still functional
		const isFileInput =
			!!node.originalNode.tagName &&
			node.originalNode.tagName.toLowerCase() === 'input' &&
			!!node.originalNode.attributes &&
			node.originalNode.attributes['type'] === 'file'

		if (
			isVisible || // Keep all visible nodes
			node.originalNode.isActuallyScrollable ||
			node.originalNode.nodeType === NodeType.TEXT_NODE ||
			node.children.length ||
			isFileInput // Keep file inputs even if not visible
		) {
			return node
		}

		return null
	}

	private _collectInteractiveElements(node: SimplifiedNode, elements: SimplifiedNode[]): void {
		const interactive = this._isInteractiveCached(node.originalNode)
		const isVisible = !!(node.originalNode.snapshotNode && node.originalNode.isVisible)

		// Only collect elements that are both interactive AND visible
		if (interactive && isVisible) {
			elements.push(node)
		}

		for (const child of node.children) {
			this._collectInteractiveElements(child, elements)
		}
	}

	private _hasInteractiveDescendants(node: SimplifiedNode): boolean {
		for (const child of node.children) {
			if (this._isInteractiveCached(child.originalNode)) {
				return true
			}
			if (this._hasInteractiveDescendants(child)) {
				return true
			}
		}
		return false
	}

	private _isInsideShadowDom(node: SimplifiedNode): boolean {
		/**
		 * Check if a node is inside a shadow DOM by walking up the parent chain.
		 *
		 * Shadow DOM elements are descendants of a #document-fragment node (shadow root).
		 * The shadow root node has nodeType == DOCUMENT_FRAGMENT_NODE and shadowRootType set.
		 */
		let current = node.originalNode.parentNode
		while (current !== null && current !== undefined) {
			if (current.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE && current.shadowRootType != null) {
				return true
			}
			current = current.parentNode
		}
		return false
	}

	private _reserveBackendNodeIds(root: SimplifiedNode | null): void {
		if (root === null) {
			return
		}

		const stack: SimplifiedNode[] = [root]
		while (stack.length) {
			const node = stack.pop()!
			this._reservedBackendNodeIds.add(node.originalNode.backendNodeId)
			stack.push(...node.children)
		}
		const maxReserved =
			this._reservedBackendNodeIds.size > 0 ? Math.max(...this._reservedBackendNodeIds) : 0
		this._nextSyntheticIndex = maxReserved + 1
	}

	private _allocateSelectorIndex(backendNodeId: number): number {
		if (!(backendNodeId in this._selectorMap)) {
			return backendNodeId
		}

		while (this._reservedBackendNodeIds.has(this._nextSyntheticIndex)) {
			this._nextSyntheticIndex += 1
		}
		const selectorIndex = this._nextSyntheticIndex
		this._nextSyntheticIndex += 1
		return selectorIndex
	}

	private _assignInteractiveIndicesAndMarkNewNodes(node: SimplifiedNode | null): void {
		if (!node) {
			return
		}

		// Skip assigning index to excluded nodes, or ignored by paint order
		if (!node.excludedByParent && !node.ignoredByPaintOrder) {
			const isInteractiveAssign = this._isInteractiveCached(node.originalNode)
			const isVisible = !!(node.originalNode.snapshotNode && node.originalNode.isVisible)
			const isScrollable = !!node.originalNode.isActuallyScrollable

			// DIAGNOSTIC: Log when interactive elements don't have snapshotNode
			if (isInteractiveAssign && !node.originalNode.snapshotNode) {
				const attrs = node.originalNode.attributes || {}
				const attrStr = `name=${attrs['name'] ?? ''} id=${attrs['id'] ?? ''} type=${attrs['type'] ?? ''}`
				const inShadow = this._isInsideShadowDom(node)
				if (
					inShadow &&
					node.originalNode.tagName &&
					['input', 'button', 'select', 'textarea', 'a'].includes(node.originalNode.tagName.toLowerCase())
				) {
					console.debug(
						`INCLUDING shadow DOM <${node.originalNode.tagName}> (no snapshotNode but in shadow DOM): ` +
							`backendNodeId=${node.originalNode.backendNodeId} ${attrStr}`,
					)
				} else {
					console.debug(
						`SKIPPING interactive <${node.originalNode.tagName}> (no snapshotNode, not in shadow DOM): ` +
							`backendNodeId=${node.originalNode.backendNodeId} ${attrStr}`,
					)
				}
			}

			// EXCEPTION: File inputs are often hidden with opacity:0 but are still functional
			const isFileInput =
				!!node.originalNode.tagName &&
				node.originalNode.tagName.toLowerCase() === 'input' &&
				!!node.originalNode.attributes &&
				node.originalNode.attributes['type'] === 'file'

			// EXCEPTION: Shadow DOM form elements may not have snapshot layout data from CDP's
			// DOMSnapshot.captureSnapshot, but they're still functional/interactive.
			const isShadowDomElement =
				isInteractiveAssign &&
				!node.originalNode.snapshotNode &&
				!!node.originalNode.tagName &&
				['input', 'button', 'select', 'textarea', 'a'].includes(node.originalNode.tagName.toLowerCase()) &&
				this._isInsideShadowDom(node)

			// Check if scrollable container should be made interactive
			// For scrollable elements, ONLY make them interactive if they have no interactive descendants
			let shouldMakeInteractive = false
			if (isScrollable) {
				const attrs = node.originalNode.attributes || {}
				const role = (attrs['role'] ?? '').toLowerCase()
				const tagName = (node.originalNode.tagName || '').toLowerCase()
				const classAttr = (attrs['class'] ?? '').toLowerCase()
				const classList = classAttr ? classAttr.split(/\s+/) : []

				// Detect dropdown containers by role, tag, or class
				const isDropdownByRole = ['listbox', 'menu', 'combobox', 'menubar', 'tree', 'grid'].includes(role)
				const isDropdownByTag = tagName === 'select'
				const isDropdownByClass =
					classList.includes('dropdown') ||
					classList.includes('dropdown-menu') ||
					classList.includes('select-menu') ||
					(classList.includes('ui') && classAttr.includes('dropdown')) // Semantic UI
				const isDropdownContainer = isDropdownByRole || isDropdownByTag || isDropdownByClass

				if (isDropdownContainer) {
					// Always index dropdown containers - need to be targetable for select_dropdown
					shouldMakeInteractive = true
				} else {
					const hasInteractiveDesc = this._hasInteractiveDescendants(node)
					// Only make scrollable container interactive if it has no interactive descendants
					if (!hasInteractiveDesc) {
						shouldMakeInteractive = true
					}
				}
			} else if (isInteractiveAssign && (isVisible || isFileInput || isShadowDomElement)) {
				// Non-scrollable interactive elements: make interactive if visible (or file input or shadow DOM form element)
				shouldMakeInteractive = true
			}

			// Add to selector map if element should be interactive
			if (shouldMakeInteractive) {
				node.isInteractive = true
				node.selectorIndex = this._allocateSelectorIndex(node.originalNode.backendNodeId)
				this._selectorMap[node.selectorIndex] = node.originalNode
				this._interactiveCounter += 1

				// Mark compound components as new for visibility
				if (node.isCompoundComponent) {
					node.isNew = true
				} else if (this._previousNodeIds.size > 0) {
					const currentNodeId = `${node.originalNode.sessionId != null ? String(node.originalNode.sessionId) : 'null'}|${node.originalNode.backendNodeId}`
					if (!this._previousNodeIds.has(currentNodeId)) {
						node.isNew = true
					}
				}
			}
		}

		// Process children
		for (const child of node.children) {
			this._assignInteractiveIndicesAndMarkNewNodes(child)
		}
	}

	private _applyBoundingBoxFiltering(node: SimplifiedNode | null): SimplifiedNode | null {
		if (!node) {
			return null
		}

		// Start with no active bounds
		this._filterTreeRecursive(node, null, 0)

		// Log statistics
		const excludedCount = this._countExcludedNodes(node)
		if (excludedCount > 0) {
			console.debug(`BBox filtering excluded ${excludedCount} nodes`)
		}

		return node
	}

	private _filterTreeRecursive(
		node: SimplifiedNode,
		activeBounds: PropagatingBounds | null = null,
		depth = 0,
	): void {
		/**
		 * Recursively filter tree with bounding box propagation.
		 * Bounds propagate to ALL descendants until overridden.
		 */

		// Check if this node should be excluded by active bounds
		if (activeBounds && this._shouldExcludeChild(node, activeBounds)) {
			node.excludedByParent = true
			// Important: Still check if this node starts NEW propagation
		}

		// Check if this node starts new propagation (even if excluded!)
		let newBounds: PropagatingBounds | null = null
		const tag = node.originalNode.tagName.toLowerCase()
		const role = node.originalNode.attributes ? (node.originalNode.attributes['role'] ?? null) : null
		const attributes: Record<string, string | null> = {
			tag,
			role,
		}
		// Check if this element matches any propagating element pattern
		if (this._isPropagatingElement(attributes)) {
			// This node propagates bounds to ALL its descendants
			if (node.originalNode.snapshotNode?.bounds) {
				newBounds = {
					tag,
					bounds: node.originalNode.snapshotNode.bounds,
					nodeId: node.originalNode.nodeId,
					depth,
				} as PropagatingBounds
			}
		}

		// Propagate to ALL children
		// Use newBounds if this node starts propagation, otherwise continue with activeBounds
		const propagateBounds = newBounds ?? activeBounds

		for (const child of node.children) {
			this._filterTreeRecursive(child, propagateBounds, depth + 1)
		}
	}

	private _shouldExcludeChild(node: SimplifiedNode, activeBounds: PropagatingBounds): boolean {
		// Never exclude text nodes - we always want to preserve text content
		if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			return false
		}

		// Get child bounds
		if (!node.originalNode.snapshotNode?.bounds) {
			return false // No bounds = can't determine containment
		}

		const childBounds = node.originalNode.snapshotNode.bounds

		// Check containment with configured threshold
		if (!this._isContained(childBounds, activeBounds.bounds, this.containmentThreshold)) {
			return false // Not sufficiently contained
		}

		// EXCEPTION RULES - Keep these even if contained:

		const childTag = node.originalNode.tagName.toLowerCase()
		const childRole = node.originalNode.attributes ? (node.originalNode.attributes['role'] ?? null) : null
		const childAttributes: Record<string, string | null> = {
			tag: childTag,
			role: childRole,
		}

		// 1. Never exclude form elements (they need individual interaction)
		if (['input', 'select', 'textarea', 'label'].includes(childTag)) {
			return false
		}

		// 2. Keep if child is also a propagating element
		// (might have stopPropagation, e.g., button in button)
		if (this._isPropagatingElement(childAttributes)) {
			return false
		}

		// 3. Keep if has explicit onclick handler
		if (node.originalNode.attributes && 'onclick' in node.originalNode.attributes) {
			return false
		}

		// 4. Keep if has aria-label suggesting it's independently interactive
		if (node.originalNode.attributes) {
			const ariaLabel = node.originalNode.attributes['aria-label']
			if (ariaLabel && ariaLabel.trim()) {
				return false
			}
		}

		// 5. Keep if has role suggesting interactivity
		if (node.originalNode.attributes) {
			const role = node.originalNode.attributes['role']
			if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option'].includes(role)) {
				return false
			}
		}

		// Default: exclude this child
		return true
	}

	private _isContained(child: DOMRect, parent: DOMRect, threshold: number): boolean {
		/**
		 * Check if child is contained within parent bounds.
		 *
		 * @param threshold Percentage (0.0-1.0) of child that must be within parent
		 */
		const xOverlap = Math.max(0, Math.min(child.x + child.width, parent.x + parent.width) - Math.max(child.x, parent.x))
		const yOverlap = Math.max(0, Math.min(child.y + child.height, parent.y + parent.height) - Math.max(child.y, parent.y))

		const intersectionArea = xOverlap * yOverlap
		const childArea = child.width * child.height

		if (childArea === 0) {
			return false // Zero-area element
		}

		const containmentRatio = intersectionArea / childArea
		return containmentRatio >= threshold
	}

	private _countExcludedNodes(node: SimplifiedNode, count = 0): number {
		if (node.excludedByParent) {
			count += 1
		}
		for (const child of node.children) {
			count = this._countExcludedNodes(child, count)
		}
		return count
	}

	private _isPropagatingElement(attributes: Record<string, string | null>): boolean {
		/**
		 * Check if an element should propagate bounds based on attributes.
		 * If the element satisfies one of the patterns, it propagates bounds to all its children.
		 */
		const keysToCheck = ['tag', 'role'] as const
		for (const pattern of DOMTreeSerializer.PROPAGATING_ELEMENTS) {
			const check = keysToCheck.map(
				(key) => pattern[key] === null || pattern[key] === attributes[key],
			)
			if (check.every(Boolean)) {
				return true
			}
		}
		return false
	}

	static serializeTree(node: SimplifiedNode | null, includeAttributes: string[], depth = 0): string {
		if (!node) {
			return ''
		}

		// Skip rendering excluded nodes, but process their children
		if (node.excludedByParent) {
			const formattedText: string[] = []
			for (const child of node.children) {
				const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, depth)
				if (childText) {
					formattedText.push(childText)
				}
			}
			return formattedText.join('\n')
		}

		const formattedText: string[] = []
		const depthStr = '\t'.repeat(depth)
		let nextDepth = depth

		if (node.originalNode.nodeType === NodeType.ELEMENT_NODE) {
			// Skip displaying nodes marked as shouldDisplay=False
			if (!node.shouldDisplay) {
				for (const child of node.children) {
					const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, depth)
					if (childText) {
						formattedText.push(childText)
					}
				}
				return formattedText.join('\n')
			}

			// Special handling for SVG elements - show the tag but collapse children
			if (node.originalNode.tagName.toLowerCase() === 'svg') {
				let shadowPrefix = ''
				if (node.isShadowHost) {
					const hasClosedShadow = node.children.some(
						(child) =>
							child.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
							child.originalNode.shadowRootType &&
							String(child.originalNode.shadowRootType).toLowerCase() === 'closed',
					)
					shadowPrefix = hasClosedShadow ? '|SHADOW(closed)|' : '|SHADOW(open)|'
				}

				let line = `${depthStr}${shadowPrefix}`
				// Add interactive marker if clickable
				if (node.isInteractive) {
					if (node.selectorIndex == null) {
						throw new Error('selectorIndex is required for interactive SVG node')
					}
					const newPrefix = node.isNew ? '*' : ''
					line += `${newPrefix}[${node.selectorIndex}]`
				}
				line += '<svg'
				const attributesHtmlStr = DOMTreeSerializer._buildAttributesString(
					node.originalNode,
					includeAttributes,
					'',
				)
				if (attributesHtmlStr) {
					line += ` ${attributesHtmlStr}`
				}
				line += ' /> <!-- SVG content collapsed -->'
				formattedText.push(line)
				// Don't process children for SVG
				return formattedText.join('\n')
			}

			// Add element if clickable, scrollable, or iframe
			const isAnyScrollable =
				!!node.originalNode.isActuallyScrollable || !!node.originalNode.isScrollable
			const shouldShowScroll = !!node.originalNode.shouldShowScrollInfo
			if (
				node.isInteractive ||
				isAnyScrollable ||
				node.originalNode.tagName.toUpperCase() === 'IFRAME' ||
				node.originalNode.tagName.toUpperCase() === 'FRAME'
			) {
				nextDepth += 1

				// Build attributes string with compound component info
				const textContent = ''
				let attributesHtmlStr = DOMTreeSerializer._buildAttributesString(
					node.originalNode,
					includeAttributes,
					textContent,
				)

				// Add compound component information to attributes if present
				const compoundChildren = getCompoundChildren(node.originalNode)
				if (compoundChildren.length) {
					const compoundInfo: string[] = []
					for (const childInfo of compoundChildren) {
						const parts: string[] = []
						if (childInfo.name) {
							parts.push(`name=${childInfo.name}`)
						}
						if (childInfo.role) {
							parts.push(`role=${childInfo.role}`)
						}
						if (childInfo.valuemin !== null && childInfo.valuemin !== undefined) {
							parts.push(`min=${childInfo.valuemin}`)
						}
						if (childInfo.valuemax !== null && childInfo.valuemax !== undefined) {
							parts.push(`max=${childInfo.valuemax}`)
						}
						if (childInfo.valuenow !== null && childInfo.valuenow !== undefined) {
							parts.push(`current=${childInfo.valuenow}`)
						}

						// Add select-specific information
						if (childInfo.options_count !== undefined && childInfo.options_count !== null) {
							parts.push(`count=${childInfo.options_count}`)
						}
						if (childInfo.first_options && childInfo.first_options.length) {
							const optionsStr = childInfo.first_options.slice(0, 4).join('|')
							parts.push(`options=${optionsStr}`)
						}
						if (childInfo.format_hint) {
							parts.push(`format=${childInfo.format_hint}`)
						}

						if (parts.length) {
							compoundInfo.push(`(${parts.join(',')})`)
						}
					}

					if (compoundInfo.length) {
						const compoundAttr = `compound_components=${compoundInfo.join(',')}`
						if (attributesHtmlStr) {
							attributesHtmlStr += ` ${compoundAttr}`
						} else {
							attributesHtmlStr = compoundAttr
						}
					}
				}

				// Build the line with shadow host indicator
				let shadowPrefix = ''
				if (node.isShadowHost) {
					const hasClosedShadow = node.children.some(
						(child) =>
							child.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE &&
							child.originalNode.shadowRootType &&
							String(child.originalNode.shadowRootType).toLowerCase() === 'closed',
					)
					shadowPrefix = hasClosedShadow ? '|SHADOW(closed)|' : '|SHADOW(open)|'
				}

				let line: string
				if (shouldShowScroll && !node.isInteractive) {
					// Scrollable container but not clickable
					line = `${depthStr}${shadowPrefix}|scroll element|<${node.originalNode.tagName}`
				} else if (node.isInteractive) {
					if (node.selectorIndex == null) {
						throw new Error('selectorIndex is required for interactive node')
					}
					const newPrefix = node.isNew ? '*' : ''
					const scrollPrefix = shouldShowScroll ? '|scroll element[' : '['
					line = `${depthStr}${shadowPrefix}${newPrefix}${scrollPrefix}${node.selectorIndex}]<${node.originalNode.tagName}`
				} else if (node.originalNode.tagName.toUpperCase() === 'IFRAME') {
					line = `${depthStr}${shadowPrefix}|IFRAME|<${node.originalNode.tagName}`
				} else if (node.originalNode.tagName.toUpperCase() === 'FRAME') {
					line = `${depthStr}${shadowPrefix}|FRAME|<${node.originalNode.tagName}`
				} else {
					line = `${depthStr}${shadowPrefix}<${node.originalNode.tagName}`
				}

				if (attributesHtmlStr) {
					line += ` ${attributesHtmlStr}`
				}

				line += ' />'

				// Add scroll information only when we should show it
				if (shouldShowScroll) {
					const scrollInfoText = node.originalNode.getScrollInfoText()
					if (scrollInfoText) {
						line += ` (${scrollInfoText})`
					}
				}

				formattedText.push(line)
			}
		} else if (node.originalNode.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
			// Shadow DOM representation - show clearly to LLM
			if (
				node.originalNode.shadowRootType &&
				String(node.originalNode.shadowRootType).toLowerCase() === 'closed'
			) {
				formattedText.push(`${depthStr}Closed Shadow`)
			} else {
				formattedText.push(`${depthStr}Open Shadow`)
			}

			nextDepth += 1

			// Process shadow DOM children
			for (const child of node.children) {
				const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth)
				if (childText) {
					formattedText.push(childText)
				}
			}

			// Close shadow DOM indicator
			if (node.children.length) {
				// Only show close if we had content
				formattedText.push(`${depthStr}Shadow End`)
			}
		} else if (node.originalNode.nodeType === NodeType.TEXT_NODE) {
			// Include visible text
			const isVisible = !!(node.originalNode.snapshotNode && node.originalNode.isVisible)
			if (
				isVisible &&
				node.originalNode.nodeValue &&
				node.originalNode.nodeValue.trim() &&
				node.originalNode.nodeValue.trim().length > 1
			) {
				const cleanText = node.originalNode.nodeValue.trim()
				formattedText.push(`${depthStr}${cleanText}`)
			}
		}

		// Process children (for non-shadow elements)
		if (node.originalNode.nodeType !== NodeType.DOCUMENT_FRAGMENT_NODE) {
			for (const child of node.children) {
				const childText = DOMTreeSerializer.serializeTree(child, includeAttributes, nextDepth)
				if (childText) {
					formattedText.push(childText)
				}
			}

			// Add hidden content hint for iframes
			if (
				node.originalNode.nodeType === NodeType.ELEMENT_NODE &&
				node.originalNode.tagName &&
				['IFRAME', 'FRAME'].includes(node.originalNode.tagName.toUpperCase())
			) {
				if (node.originalNode.hiddenElementsInfo?.length) {
					const hidden = node.originalNode.hiddenElementsInfo
					const hintLines = [
						`${depthStr}... (${hidden.length} more elements below - scroll to reveal):`,
					]
					for (const elem of hidden) {
						hintLines.push(
							`${depthStr}    <${elem['tag']}> "${elem['text']}" ~${elem['pages']} pages down`,
						)
					}
					formattedText.push(...hintLines)
				} else if (node.originalNode.hasHiddenContent) {
					formattedText.push(`${depthStr}... (more content below viewport - scroll to reveal)`)
				}
			}
		}

		return formattedText.join('\n')
	}

	static _buildAttributesString(
		node: EnhancedDOMTreeNode,
		includeAttributes: string[],
		text: string,
	): string {
		const attributesToInclude: Record<string, string> = {}

		// Include HTML attributes
		if (node.attributes) {
			for (const [key, value] of Object.entries(node.attributes)) {
				if (includeAttributes.includes(key) && String(value).trim() !== '') {
					attributesToInclude[key] = String(value).trim()
				}
			}
		}

		// Add format hints for date/time inputs to help LLMs use the correct format
		// NOTE: These formats are standardized by HTML5 specification (ISO 8601), NOT locale-dependent
		if (node.tagName && node.tagName.toLowerCase() === 'input' && node.attributes) {
			const inputType = (node.attributes['type'] ?? '').toLowerCase()

			// For HTML5 date/time inputs, add a highly visible "format" attribute
			if (['date', 'time', 'datetime-local', 'month', 'week'].includes(inputType)) {
				const formatMap: Record<string, string> = {
					date: 'YYYY-MM-DD',
					time: 'HH:MM',
					'datetime-local': 'YYYY-MM-DDTHH:MM',
					month: 'YYYY-MM',
					week: 'YYYY-W##',
				}
				attributesToInclude['format'] = formatMap[inputType]
			}

			// Only add placeholder if it doesn't already exist
			if (includeAttributes.includes('placeholder') && !('placeholder' in attributesToInclude)) {
				if (inputType === 'date') {
					attributesToInclude['placeholder'] = 'YYYY-MM-DD'
				} else if (inputType === 'time') {
					attributesToInclude['placeholder'] = 'HH:MM'
				} else if (inputType === 'datetime-local') {
					attributesToInclude['placeholder'] = 'YYYY-MM-DDTHH:MM'
				} else if (inputType === 'month') {
					attributesToInclude['placeholder'] = 'YYYY-MM'
				} else if (inputType === 'week') {
					attributesToInclude['placeholder'] = 'YYYY-W##'
				} else if (inputType === 'tel' && !('pattern' in attributesToInclude)) {
					attributesToInclude['placeholder'] = '123-456-7890'
				} else if (inputType === 'text' || inputType === '') {
					const classAttr = (node.attributes['class'] ?? '').toLowerCase()

					// Check for AngularJS UI Bootstrap datepicker (uib-datepicker-popup attribute)
					if ('uib-datepicker-popup' in node.attributes) {
						const dateFormat = node.attributes['uib-datepicker-popup'] ?? ''
						if (dateFormat) {
							attributesToInclude['expected_format'] = dateFormat
							attributesToInclude['format'] = dateFormat
						}
					} else if (
						['datepicker', 'datetimepicker', 'daterangepicker'].some((indicator) =>
							classAttr.includes(indicator),
						)
					) {
						const dateFormat = node.attributes['data-date-format'] ?? ''
						if (dateFormat) {
							attributesToInclude['placeholder'] = dateFormat
							attributesToInclude['format'] = dateFormat
						} else {
							attributesToInclude['placeholder'] = 'mm/dd/yyyy'
							attributesToInclude['format'] = 'mm/dd/yyyy'
						}
					} else if ('data-datepicker' in node.attributes) {
						const dateFormat = node.attributes['data-date-format'] ?? ''
						if (dateFormat) {
							attributesToInclude['placeholder'] = dateFormat
							attributesToInclude['format'] = dateFormat
						} else {
							attributesToInclude['placeholder'] = 'mm/dd/yyyy'
							attributesToInclude['format'] = 'mm/dd/yyyy'
						}
					}
				}
			}
		}

		// Never include values from password fields - they contain secrets that must not
		// leak into DOM snapshots sent to the LLM, where prompt injection could exfiltrate them.
		const isPasswordField =
			!!node.tagName &&
			node.tagName.toLowerCase() === 'input' &&
			!!node.attributes &&
			(node.attributes['type'] ?? '').toLowerCase() === 'password'

		// Include accessibility properties
		if (node.axNode?.properties) {
			const valueProperties = new Set(['value', 'valuetext'])
			for (const prop of node.axNode.properties) {
				try {
					if (includeAttributes.includes(prop.name) && prop.value !== null && prop.value !== undefined) {
						if (isPasswordField && valueProperties.has(prop.name)) {
							continue
						}
						// Convert boolean to lowercase string, keep others as-is
						if (typeof prop.value === 'boolean') {
							attributesToInclude[prop.name] = String(prop.value).toLowerCase()
						} else {
							const propValueStr = String(prop.value).trim()
							if (propValueStr) {
								attributesToInclude[prop.name] = propValueStr
							}
						}
					}
				} catch {
					continue
				}
			}
		}

		// Special handling for form elements - ensure current value is shown
		// For text inputs, textareas, and selects, prioritize showing the current value from AX tree
		if (node.tagName && ['input', 'textarea', 'select'].includes(node.tagName.toLowerCase())) {
			if (isPasswordField) {
				delete attributesToInclude['value']
			} else if (node.axNode?.properties) {
				// ALWAYS check AX tree - it reflects actual typed value, DOM attribute may not update
				for (const prop of node.axNode.properties) {
					if (prop.name === 'valuetext' && prop.value) {
						const valueStr = String(prop.value).trim()
						if (valueStr) {
							attributesToInclude['value'] = valueStr
							break
						}
					} else if (prop.name === 'value' && prop.value) {
						const valueStr = String(prop.value).trim()
						if (valueStr) {
							attributesToInclude['value'] = valueStr
							break
						}
					}
				}
			}
		}

		if (!Object.keys(attributesToInclude).length) {
			return ''
		}

		// Remove duplicate values
		const orderedKeys = includeAttributes.filter((key) => key in attributesToInclude)

		if (orderedKeys.length > 1) {
			const keysToRemove = new Set<string>()
			const seenValues: Record<string, string> = {}

			// Attributes that should never be removed as duplicates (they serve distinct purposes)
			const protectedAttrs = new Set([
				'format',
				'expected_format',
				'placeholder',
				'value',
				'aria-label',
				'title',
			])

			for (const key of orderedKeys) {
				const value = attributesToInclude[key]
				if (value.length > 5) {
					if (value in seenValues && !protectedAttrs.has(key)) {
						keysToRemove.add(key)
					} else {
						seenValues[value] = key
					}
				}
			}

			for (const key of keysToRemove) {
				delete attributesToInclude[key]
			}
		}

		// Remove attributes that duplicate accessibility data
		const role = node.axNode?.role ?? null
		if (role && node.nodeName === role) {
			delete attributesToInclude['role']
		}

		// Remove type attribute if it matches the tag name (e.g. <button type="button">)
		if (
			'type' in attributesToInclude &&
			attributesToInclude['type'].toLowerCase() === node.nodeName.toLowerCase()
		) {
			delete attributesToInclude['type']
		}

		// Remove invalid attribute if it's false (only show when true)
		if ('invalid' in attributesToInclude && attributesToInclude['invalid'].toLowerCase() === 'false') {
			delete attributesToInclude['invalid']
		}

		const booleanAttrs = ['required']
		for (const attr of booleanAttrs) {
			if (
				attr in attributesToInclude &&
				['false', '0', 'no'].includes(attributesToInclude[attr].toLowerCase())
			) {
				delete attributesToInclude[attr]
			}
		}

		// Remove aria-expanded if we have expanded (prefer AX tree over HTML attribute)
		if ('expanded' in attributesToInclude && 'aria-expanded' in attributesToInclude) {
			delete attributesToInclude['aria-expanded']
		}

		const attrsToRemoveIfTextMatches = ['aria-label', 'placeholder', 'title']
		for (const attr of attrsToRemoveIfTextMatches) {
			if (
				attributesToInclude[attr] &&
				attributesToInclude[attr].trim().toLowerCase() === text.trim().toLowerCase()
			) {
				delete attributesToInclude[attr]
			}
		}

		if (Object.keys(attributesToInclude).length) {
			// Format attributes, wrapping empty values in quotes for clarity
			const formattedAttrs: string[] = []
			for (const [key, value] of Object.entries(attributesToInclude)) {
				const cappedValue = capTextLength(value, 100)
				// Show empty values as key='' instead of key=
				if (!cappedValue) {
					formattedAttrs.push(`${key}=''`)
				} else {
					formattedAttrs.push(`${key}=${cappedValue}`)
				}
			}
			return formattedAttrs.join(' ')
		}

		return ''
	}
}
