import assert from 'node:assert/strict';
import test from 'node:test';
import {parseFlowchart, renderFlowchart} from '../openteamily/static/chat/flowchart.mjs';

function createElement(tag) {
  return {
    tag, children:[], dataset:{}, style:{}, attributes:{},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { this.children.push(child); },
  };
}
const document = {createElement};

test('parses Mermaid-style directions, shapes, comments, branches and chained edges', () => {
  const graph = parseFlowchart([
    '%% release checklist',
    'graph TD; Start([开始]) --> Check{已确认？}',
    'Check -->|是| Ship["发布; 通知"] --> End((结束))',
    'Check -. 稍后 .-> Note[待定 %% 保留] %% trailing comment',
    'Note --- End',
  ].join('\n'));
  assert.equal(graph.direction, 'TD');
  assert.deepEqual(graph.nodes, [
    {id:'Start', label:'开始', shape:'round'}, {id:'Check', label:'已确认？', shape:'diamond'},
    {id:'Ship', label:'发布; 通知', shape:'rect'}, {id:'End', label:'结束', shape:'round'},
    {id:'Note', label:'待定 %% 保留', shape:'rect'},
  ]);
  assert.deepEqual(graph.edges, [
    {from:'Start', to:'Check', line:'solid', directed:true, label:''},
    {from:'Check', to:'Ship', line:'solid', directed:true, label:'是'},
    {from:'Ship', to:'End', line:'solid', directed:true, label:''},
    {from:'Check', to:'Note', line:'dashed', directed:true, label:'稍后'},
    {from:'Note', to:'End', line:'solid', directed:false, label:''},
  ]);
});

test('renders labels as text, accessible graph relations, and deterministic reversed directions', () => {
  for (const direction of ['TB', 'TD', 'BT', 'LR', 'RL']) {
    const source = `flowchart ${direction}\n A["Before<br/><img src=https://example.invalid>"] ==>|next| B(after)`;
    const chart = renderFlowchart(document, source);
    const [stage] = chart.children;
    const [a, b] = stage.children.filter(item => item.className === 'chat-flowchart-node');
    assert.equal(chart.tabIndex, 0);
    assert.equal(stage.attributes.role, 'img');
    assert.match(stage.attributes['aria-label'], /到 after（next）/);
    assert.equal(a.children[0].textContent, 'Before\n<img src=https://example.invalid>');
    assert.ok(stage.children.some(item => item.dataset.line === 'thick'));
    assert.ok(stage.children.some(item => item.className === 'chat-flowchart-arrow'));
    const axis = ['LR', 'RL'].includes(direction) ? 'left' : 'top';
    assert.equal(parseFloat(a.style[axis]) < parseFloat(b.style[axis]), !['BT', 'RL'].includes(direction));
    assert.equal(JSON.stringify(chart), JSON.stringify(renderFlowchart(document, source)));
  }
});

test('renders feedback arrows on an exterior lane without changing the primary flow ranks', () => {
  const source = 'flowchart TB\nA[提交] --> B{审核} --> C[通过]\nB -->|退回| A\nC -->|重试| C';
  const chart = renderFlowchart(document, source);
  const [stage] = chart.children;
  const nodes = stage.children.filter(item => item.className === 'chat-flowchart-node');
  const arrows = stage.children.filter(item => item.className === 'chat-flowchart-arrow');
  const labels = stage.children.filter(item => item.className === 'chat-flowchart-edge-label');
  assert.equal(arrows.length, 4);
  assert.equal(labels.length, 2);
  assert.match(stage.attributes['aria-label'], /审核 到 提交（退回）.*通过 到 通过（重试）/);
  const rightmost = Math.max(...nodes.map(node => parseFloat(node.style.left) + parseFloat(node.style.width)));
  assert.ok(labels.every(label => parseFloat(label.style.left) > rightmost));
  assert.ok(parseFloat(nodes[0].style.top) < parseFloat(nodes[1].style.top));
  assert.ok(parseFloat(nodes[1].style.top) < parseFloat(nodes[2].style.top));
});

test('returns the original-code fallback sentinel for unsupported, malformed and oversized graphs', () => {
  for (const source of [
    'sequenceDiagram\nA->>B: hi',
    'flowchart LR\nsubgraph cluster\nA-->B\nend',
    'flowchart TB\nA["unclosed]-->B',
    'flowchart TB\nA-->B\nclick A javascript:alert(1)',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA-->B',
    'flowchart TB\n' + Array.from({length:37}, (_, index) => `n${index}`).join('-->'),
  ]) assert.equal(renderFlowchart(document, source), null);
});
