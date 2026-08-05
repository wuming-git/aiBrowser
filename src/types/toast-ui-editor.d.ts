/** @toast-ui/editor 的 package.json exports 未声明 types，补一层模块声明供 vue-tsc 使用。 */
declare module '@toast-ui/editor' {
  export type EditorType = 'markdown' | 'wysiwyg'

  export interface EditorOptions {
    el: HTMLElement
    height?: string
    minHeight?: string
    initialValue?: string
    initialEditType?: EditorType
    previewStyle?: 'tab' | 'vertical'
    hideModeSwitch?: boolean
    usageStatistics?: boolean
    language?: string
    placeholder?: string
    toolbarItems?: unknown[]
    [key: string]: unknown
  }

  export default class Editor {
    constructor(options: EditorOptions)
    getMarkdown(): string
    setMarkdown(markdown: string, cursorToEnd?: boolean): void
    setHeight(height: string | number): void
    getHeight(): string
    destroy(): void
  }
}

declare module '@toast-ui/editor/dist/i18n/zh-cn'
