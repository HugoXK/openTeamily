import { markdownToBlocks, renderMarkdown } from '../shell/markdown.mjs';
import { readMarkdownTable, renderMarkdownTable } from '../shell/markdown-table.mjs';
import { renderChatCodeBlock } from './code-block.mjs';

let flowchartModule;

export function hasExplicitRichContent(source) {
  if (!/[|]|\x60{3}|~{3}/.test(source)) return false;
  return markdownToBlocks(source, {readTable:readMarkdownTable}).some(block =>
    block.type === 'table' || (block.type === 'code' && (block.closed || block.language === 'mermaid')));
}

function renderCode(document, block) {
  const code = renderChatCodeBlock(document, block);
  const english = document.documentElement?.lang === 'en';
  const label = english ? 'Code' : '代码';
  code.dataset.summary = block.language ? `${label} · ${block.language}` : label;
  if (block.language !== 'mermaid' || !block.closed) return code;

  const container = document.createElement('div');
  container.className = 'chat-diagram';
  container.dataset.summary = english ? 'Mermaid diagram' : 'Mermaid 流程图';
  container.append(code);
  queueMicrotask(() => {
    if (!container.isConnected) return;
    const fold = container.closest('details:not([open])');
    if (!fold) void showFlowchart(document, container, code, block.text, english);
    else fold.addEventListener('toggle', function onOpen() {
      if (!fold.open) return;
      fold.removeEventListener('toggle', onOpen);
      void showFlowchart(document, container, code, block.text, english);
    });
  });
  return container;
}

async function showFlowchart(document, container, code, text, english) {
  flowchartModule ??= import('./flowchart.mjs').catch(() => {
    flowchartModule = undefined;
    return null;
  });
  try {
    const module = await flowchartModule;
    if (!container.isConnected || !module) return;
    const diagram = module.renderFlowchart(document, text);
    if (!diagram) return;
    const scroller = container.closest('#message-scroller');
    const atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
    const source = document.createElement('details');
    const summary = document.createElement('summary');
    const focused = code.contains(document.activeElement) ? document.activeElement : null;
    source.className = 'chat-diagram-source';
    source.open = Boolean(focused);
    summary.textContent = english ? 'Diagram source' : '流程图源码';
    source.append(summary, code);
    container.replaceChildren(diagram, source);
    focused?.focus({preventScroll:true});
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  } catch {
    // Leave the original code visible if the chart renderer fails.
  }
}

export function renderChatMarkdown(document, node, source) {
  node.className = 'chat-markdown';
  renderMarkdown(document, node, source, {readTable:readMarkdownTable, renderTable:renderMarkdownTable, renderCode});
}
