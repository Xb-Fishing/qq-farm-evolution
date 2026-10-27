import { marked, Renderer } from 'marked'

function escapeAttribute(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]!))
}

export function renderUpdateLog(source: string): string {
  const heading = /^##\s+详细记录\s*$/m.exec(source)
  const details = (heading ? source.slice(heading.index) : source).trim()
  if (!details)
    return '<p>暂无更新日志。</p>'
  const renderer = new Renderer()
  renderer.html = () => ''
  renderer.image = ({ text }) => escapeAttribute(text)
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens)
    const target = href.trim()
    const scheme = /^([a-z][\w+.-]*):/i.exec(target)?.[1]?.toLowerCase()
    if ([...target].some(char => char.codePointAt(0)! <= 32 || char === '\\') || target.startsWith('//')
      || (scheme && !['http', 'https', 'mailto'].includes(scheme))) {
      return text
    }
    const caption = title ? ` title="${escapeAttribute(title)}"` : ''
    return `<a href="${escapeAttribute(target)}"${caption} target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  return marked.parse(details, { renderer, gfm: true, breaks: false, async: false })
}
