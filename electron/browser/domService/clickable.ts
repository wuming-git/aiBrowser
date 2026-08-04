/**
 * Clickable / interactive element detection (browser-use clickable_elements.py).
 */
import type { EnhancedDOMTreeNode } from './types'
import { NodeType } from './types'

function hasFormControlDescendant(element: EnhancedDOMTreeNode, maxDepth = 2): boolean {
  if (maxDepth <= 0) return false
  for (const child of element.childrenAndShadowRoots) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue
    if (['input', 'select', 'textarea'].includes(child.tagName)) return true
    if (hasFormControlDescendant(child, maxDepth - 1)) return true
  }
  return false
}

export function isInteractive(node: EnhancedDOMTreeNode): boolean {
  if (node.nodeType !== NodeType.ELEMENT_NODE) return false
  if (node.tagName === 'html' || node.tagName === 'body') return false

  if (node.hasJsClickListener) return true

  if (node.tagName === 'iframe' || node.tagName === 'frame') {
    if (node.snapshotNode?.bounds) {
      const { width, height } = node.snapshotNode.bounds
      if (width > 100 && height > 100) return true
    }
  }

  if (node.tagName === 'label') {
    if (node.attributes?.for) return false
    if (hasFormControlDescendant(node, 2)) return true
  }

  if (node.tagName === 'span') {
    if (hasFormControlDescendant(node, 2)) return true
  }

  if (node.attributes) {
    const searchIndicators = [
      'search',
      'magnify',
      'glass',
      'lookup',
      'find',
      'query',
      'search-icon',
      'search-btn',
      'search-button',
      'searchbox',
    ]
    const classList = (node.attributes.class || '').toLowerCase().split(/\s+/)
    const classJoined = classList.join(' ')
    if (searchIndicators.some((ind) => classJoined.includes(ind))) return true

    const elementId = (node.attributes.id || '').toLowerCase()
    if (searchIndicators.some((ind) => elementId.includes(ind))) return true

    for (const [attrName, attrValue] of Object.entries(node.attributes)) {
      if (attrName.startsWith('data-') && searchIndicators.some((ind) => attrValue.toLowerCase().includes(ind))) {
        return true
      }
    }
  }

  if (node.axNode?.properties) {
    for (const prop of node.axNode.properties) {
      try {
        if (prop.name === 'disabled' && prop.value) return false
        if (prop.name === 'hidden' && prop.value) return false
        if (['focusable', 'editable', 'settable'].includes(prop.name) && prop.value) return true
        if (['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)) return true
        if (['required', 'autocomplete'].includes(prop.name) && prop.value) return true
        if (prop.name === 'keyshortcuts' && prop.value) return true
      } catch {
        continue
      }
    }
  }

  const interactiveTags = new Set([
    'button',
    'input',
    'select',
    'textarea',
    'a',
    'details',
    'summary',
    'option',
    'optgroup',
  ])
  if (node.tagName && interactiveTags.has(node.tagName.toLowerCase())) return true

  if (node.attributes) {
    const interactiveAttributes = ['onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'tabindex']
    if (interactiveAttributes.some((attr) => attr in node.attributes)) return true

    if ('role' in node.attributes) {
      const interactiveRoles = new Set([
        'button',
        'link',
        'menuitem',
        'option',
        'radio',
        'checkbox',
        'tab',
        'textbox',
        'combobox',
        'slider',
        'spinbutton',
        'search',
        'searchbox',
        'row',
        'cell',
        'gridcell',
      ])
      if (interactiveRoles.has(node.attributes.role)) return true
    }
  }

  if (node.axNode?.role) {
    const interactiveAxRoles = new Set([
      'button',
      'link',
      'menuitem',
      'option',
      'radio',
      'checkbox',
      'tab',
      'textbox',
      'combobox',
      'slider',
      'spinbutton',
      'listbox',
      'search',
      'searchbox',
      'row',
      'cell',
      'gridcell',
    ])
    if (interactiveAxRoles.has(node.axNode.role)) return true
  }

  if (
    node.snapshotNode?.bounds &&
    node.snapshotNode.bounds.width >= 10 &&
    node.snapshotNode.bounds.width <= 50 &&
    node.snapshotNode.bounds.height >= 10 &&
    node.snapshotNode.bounds.height <= 50
  ) {
    if (node.attributes) {
      const iconAttributes = ['class', 'role', 'onclick', 'data-action', 'aria-label']
      if (iconAttributes.some((attr) => attr in node.attributes)) return true
    }
  }

  if (node.snapshotNode?.cursorStyle === 'pointer') return true

  return false
}
