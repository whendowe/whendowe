// SPDX-License-Identifier: AGPL-3.0-or-later
import { html } from "./layout.js";

// The week-row editor (DESIGN §10 rc19): the plan pages' styles and, with JavaScript, the
// script that lets a stretch be picked up and put down or dragged (slice P4).
//
// The styles are ported from the owner-reviewed prototype
// (v12, 2026-10-30): a sticky header naming the plan and what it answers, week rows with
// events as labelled ribbons, and a sticky sheet for the tapped day, the editor or the
// actions. Scoped under .pl; light and dark through light-dark(), like the picker.

export const PLAN_STYLE = html`<style>
  .pl { --fg: CanvasText; --muted: light-dark(#5d6b69, #9aa9a6); --line: light-dark(#c9d1cf, #3a4644);
    --tile: light-dark(#eef2f1, #222b2a); --card: light-dark(#ffffff, #1a2221); --accent: light-dark(#0e6b66, #4fc0b6);
    --accent-soft: light-dark(#d9efec, #173936); --on: light-dark(#ffffff, #062523); --hi: light-dark(#fff4cc, #3a3214);
    --ok: light-dark(#1f6b2e, #7fd08e); --bad: light-dark(#9a2a1f, #f19185);
    --o0: light-dark(#0e6b66, #4fc0b6); --o1: light-dark(#b4511f, #f08a52); --o2: light-dark(#5b4bb3, #a99bf0);
    --o3: light-dark(#8a6a00, #e2c050); --o4: light-dark(#a3336b, #ef7db4); --o5: light-dark(#2a6a9e, #7fb6e6);
    --o6: light-dark(#5f7a12, #b9cf6a); --o7: light-dark(#8c4a2f, #d9a07f);
    display: grid; gap: 8px; font-size: 1rem; line-height: 1.45; }
  .pl p { margin: 0; }
  .pl h1 { margin: 0; font-size: 1.3rem; }
  .pl h2 { margin: 0; font-size: 1.1rem; }
  .pl h3 { margin: 0; font-size: 1rem; }
  .pl a { color: inherit; }
  .pl button, .pl .btn { font: inherit; font-size: .95rem; padding: .45rem .9rem; cursor: pointer; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--fg); text-decoration: none; display: inline-block; line-height: 1.3; }
  .pl .primary { background: var(--accent); color: var(--on); border-color: transparent; font-weight: 700; }
  .pl .link { background: none; border: 0; padding: 0; text-decoration: underline; }
  .pl button:disabled { opacity: .5; cursor: default; }
  .pl input, .pl textarea, .pl select { font: inherit; padding: .35rem .4rem; color: var(--fg); background: var(--card);
    border: 1px solid var(--line); border-radius: 6px; }
  .pl textarea, .pl .wide { width: 100%; box-sizing: border-box; }
  .pl form { margin: 0; }
  .pl .muted { color: var(--muted); opacity: 1; }
  .pl .small { font-size: .85rem; }
  .pl .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pl .spread { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pl .notice { padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); }
  .pl .error { color: var(--bad); font-weight: 700; }
  .pl label.f { display: grid; gap: 2px; font-size: .85rem; font-weight: 700; }

  .pl .head { position: sticky; top: 0; z-index: 2; background: Canvas; padding: 6px 0; border-bottom: 1px solid var(--line);
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; }
  .pl .head .l1 { font-weight: 700; display: flex; gap: 6px; align-items: center; min-width: 0; }
  .pl .head .l2 { font-size: .85rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
  .pl .head .l3 { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: start; gap: 8px; font-size: .85rem; font-weight: 700; }
  .pl .head .l3 details { min-width: 0; }
  .pl .head .l3 summary { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
  .pl .head .l3 ul { font-weight: 400; }
  .pl .status { font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px;
    border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .pl .status.on_table { color: var(--accent); } .pl .status.accepted { color: var(--ok); }
  .pl .status.replaced, .pl .status.withdrawn { color: var(--muted); } .pl .status.draft { border-style: dashed; }
  .pl .letter { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 5px; font-weight: 700;
    font-size: .78rem; color: Canvas; background: var(--muted); flex: 0 0 auto; }

  .pl .seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 3px; border-radius: 999px; border: 1px solid var(--line); }
  .pl .seg button { border: 0; border-radius: 999px; padding: .35rem; background: transparent; font-size: .9rem; }
  .pl .seg button[aria-pressed=true] { background: var(--accent); color: var(--on); font-weight: 700; }

  .pl .weeks { display: grid; gap: 8px; }
  .pl .week { border: 1px solid var(--line); border-radius: 10px; padding: 6px; background: var(--card); display: grid; gap: 5px; }
  .pl .wh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: .85rem; padding: 0 2px; }
  .pl .st { font-size: .72rem; font-weight: 700; color: var(--muted); white-space: nowrap; }
  .pl .wg { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; grid-auto-rows: minmax(1.7rem, auto); }
  .pl .dh { position: relative; padding: 2px 0; border-radius: 6px; border: 1px solid transparent; background: var(--tile); font-size: .68rem;
    line-height: 1.1; display: grid; place-items: center; min-height: 2.3rem; color: var(--muted); text-decoration: none; grid-row: 1; }
  .pl .dh b { font-size: .92rem; color: var(--fg); }
  .pl .dh.we b { font-weight: 800; }
  .pl .dh.today { border-color: var(--fg); }
  .pl .dh.picked { outline: 3px solid var(--accent); outline-offset: 1px; }
  .pl .dh.sel-end { background: var(--ev); } .pl .dh.sel-end, .pl .dh.sel-end b { color: var(--on); }
  .pl .dh.sel-mid { background: color-mix(in srgb, var(--ev) 35%, var(--tile)); }
  .pl .dh.grab { outline: 3px dashed var(--fg); outline-offset: 2px; z-index: 1; animation: pl-held 1s ease-in-out infinite alternate; }
  @keyframes pl-held { to { outline-offset: 4px; } }
  @media (prefers-reduced-motion: reduce) { .pl .dh.grab { animation: none; } }
  .pl .rib { box-sizing: border-box; display: block; min-width: 0; padding: 3px 6px; border-radius: 6px; font-size: .78rem; line-height: 1.25;
    overflow: hidden; overflow-wrap: anywhere; position: relative; text-decoration: none; color: var(--fg); }
  .pl .rib small { font-weight: 400; font-size: .7rem; }
  .pl .rib.plan { background: color-mix(in srgb, var(--x) 24%, var(--card)); border-left: 4px solid var(--x); font-weight: 700; }
  .pl .rib.agreed { background: color-mix(in srgb, var(--x) 10%, var(--tile)); color: var(--muted); }
  .pl .rib.ghost { border: 1.5px dashed var(--muted); color: var(--muted); text-decoration: line-through; }
  .pl .rib .badge { display: inline-block; margin-left: 4px; font-size: .6rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
    padding: 0 4px; border-radius: 4px; background: var(--fg); color: Canvas; text-decoration: none; vertical-align: 1px; white-space: nowrap; }
  .pl .rib.ghost .badge { background: var(--muted); }
  .pl .rib .lock { margin-left: 4px; font-size: .7rem; }
  .pl .rib.one { --w: calc((100% - 6px) / 3); white-space: nowrap; text-overflow: ellipsis; border-left: 0; padding-left: 8px; }
  .pl .rib.one.plan { background: linear-gradient(90deg, color-mix(in srgb, var(--x) 24%, var(--card)) 0 var(--w), transparent var(--w)); box-shadow: inset 4px 0 var(--x); }
  .pl .rib.one.right { text-align: right; padding: 3px 8px 3px 6px; }
  .pl .rib.one.right.plan { background: linear-gradient(270deg, color-mix(in srgb, var(--x) 24%, var(--card)) 0 var(--w), transparent var(--w)); box-shadow: inset -4px 0 var(--x); }
  .pl .rib.one.agreed { background: linear-gradient(90deg, color-mix(in srgb, var(--x) 10%, var(--tile)) 0 var(--w), transparent var(--w)); }
  .pl .rib.one.right.agreed { background: linear-gradient(270deg, color-mix(in srgb, var(--x) 10%, var(--tile)) 0 var(--w), transparent var(--w)); }
  .pl .rib.one.ghost { border: 0; border-left: 1.5px dashed var(--muted); }
  .pl .rib.one.right.ghost { border-left: 0; border-right: 1.5px dashed var(--muted); }
  .pl .rib:focus-visible, .pl .dh:focus-visible { outline: 3px solid var(--fg); }
  .pl .rib.sel { outline: 3px solid var(--fg); outline-offset: 1px; touch-action: none; }
  .pl .grip { position: absolute; top: 0; bottom: 0; width: 24px; cursor: ew-resize; display: grid; place-items: center; }
  .pl .grip::after { content: ""; width: 5px; height: 70%; min-height: 12px; border-radius: 3px; background: var(--fg); }
  .pl .rib.sel { --cw: calc((100% - (var(--n) - 1) * 3px) / var(--n)); }
  .pl .grip.s { left: calc(var(--a) * (var(--cw) + 3px)); }
  .pl .grip.e { left: calc((var(--b) + 1) * (var(--cw) + 3px) - 3px - 24px); }
  .pl .grip.on::after { width: 9px; height: 100%; background: var(--accent); }
  .pl .rib.sel.gs { padding-left: 26px; } .pl .rib.sel.ge { padding-right: 26px; }
  .pl .rib.sel.one { padding-left: calc(var(--cw) + 8px); padding-right: 6px; }
  .pl .rib.sel.one.right { padding-left: 6px; padding-right: calc(var(--cw) + 8px); }
  .pl .editing .rib:not(.sel), .pl .editing .wl { opacity: .35; }
  .pl .dragging, .pl .dragging * { user-select: none; -webkit-user-select: none; }
  .pl .wl { list-style: none; margin: 0; padding: 0 2px; display: grid; gap: 2px; font-size: .85rem; }
  .pl .wl li { padding-left: 1.2rem; text-indent: -1.2rem; }
  .pl .wl li::before { display: inline-block; width: 1.2rem; text-indent: 0; font-weight: 800; }
  .pl .wl li.add::before { content: "+"; } .pl .wl li.chg::before { content: "↷"; } .pl .wl li.rm::before { content: "−"; }
  .pl .wl li.warn::before { content: "!"; color: var(--bad); }
  .pl .wch summary { font-size: .72rem; font-weight: 700; cursor: pointer; padding: 2px 8px; border-radius: 999px; background: var(--hi); width: fit-content; }
  .pl details.fold > summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 2px 8px; cursor: pointer; list-style: none;
    border: 1px dashed var(--line); border-radius: 8px; padding: .45rem .9rem; font-size: .85rem; }
  .pl details.fold > summary::-webkit-details-marker { display: none; }
  .pl details.fold[open] > summary { margin-bottom: 8px; }
  .pl details.fold[open] { display: grid; gap: 8px; }

  .pl .sheet { position: sticky; bottom: 0; z-index: 2; background: var(--card); border: 1px solid var(--line); border-radius: 14px 14px 10px 10px;
    padding: 8px 12px; display: grid; gap: 8px; box-shadow: 0 -4px 14px rgb(0 0 0 / .08); max-height: 60vh; overflow: auto; }
  .pl .sheet > * { min-width: 0; }
  .pl .x { border: 0; background: none; padding: 2px 6px; font-size: 1.2rem; line-height: 1; color: var(--muted); text-decoration: none; }
  .pl .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .pl .rows li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: .92rem; }
  .pl .rows li .w { color: var(--muted); font-size: .85rem; }
  .pl .rows li.gone strong { text-decoration: line-through; }
  .pl .sw { display: inline-block; width: 20px; height: 8px; border-radius: 3px; flex: 0 0 auto; background: var(--x); }
  .pl .sw.stripe { background: none; border: 1.5px dashed var(--x); box-sizing: border-box; }
  .pl .sw.muted { background: color-mix(in srgb, var(--x) 30%, var(--tile)); height: 12px; }
  .pl .choose { display: grid; gap: 6px; }
  .pl .choose > a, .pl .choose button { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; align-items: center; text-align: left; width: 100%; box-sizing: border-box; }
  .pl blockquote { margin: 0; padding-left: 10px; border-left: 3px solid var(--line); font-style: italic; font-size: .92rem; }
  .pl .votes { display: flex; flex-wrap: wrap; gap: 4px; font-size: .8rem; }
  .pl .vote { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .pl .vote.yes { border-color: var(--ok); color: var(--ok); font-weight: 700; }
  .pl .vote.no { border-color: var(--bad); color: var(--bad); }
  .pl .vote.ifneedbe { border-style: dashed; }
  .pl .vote.none { color: var(--muted); }
  .pl .confirm { padding: 8px 10px; border-radius: 8px; border: 2px solid var(--accent); background: var(--accent-soft); display: grid; gap: 8px; }
  .pl .paste { font-family: ui-monospace, monospace; font-size: .8rem; }

  .pl .ed { display: grid; gap: 8px; }
  .pl .ed .eh { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
  .pl .ed .eh input { width: 100%; box-sizing: border-box; font-weight: 700; }
  .pl .dot { width: 14px; height: 14px; border-radius: 4px; background: var(--ev); }
  .pl .kind { display: flex; gap: 12px; flex-wrap: wrap; font-size: .9rem; }
  .pl .ed:has(input[name=kind][value=days]:checked) .timed, .pl .ed:has(input[name=kind][value=time]:checked) .stretch { display: none; }
  .pl .mv { display: grid; grid-template-columns: 3rem repeat(4, minmax(0, 1fr)); align-items: center; gap: 6px; }
  .pl .mv .lbl, .pl .whorow .lbl { font-size: .85rem; font-weight: 700; }
  .pl .mv button { padding: 0; height: 2.1rem; font-size: .85rem; }
  .pl .whorow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pl .whorow .lbl { width: 3rem; }
  .pl .whorow label { padding: .2rem .6rem; font-size: .85rem; border-radius: 999px; border: 1px solid var(--line); }
  .pl .whorow label:has(input:checked) { background: var(--fg); color: Canvas; border-color: var(--fg); }

  .pl .msg { border: 1px solid var(--line); border-radius: 10px; background: var(--card); display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .pl .msg.mine { border-color: var(--accent); }
  .pl .msg.replaced, .pl .msg.withdrawn { opacity: .8; border-style: dashed; }
  .pl .msg > a { display: grid; gap: 2px; padding: 8px 10px; min-width: 0; text-decoration: none; }
  .pl .msg .t1 { font-weight: 700; display: flex; gap: 6px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
  .pl .msg .t2 { font-size: .82rem; color: var(--muted); }
  .pl .msg .side { display: grid; align-content: center; padding: 6px; }
  .pl .msg .side a { font-size: .8rem; padding: .3rem .5rem; }
  .pl .group-h { margin-top: 6px; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pl .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: .9rem; }
  .pl .list li { padding: 5px 10px; border-radius: 8px; background: var(--tile); }
  .pl .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--card); display: grid; gap: 4px; }
  .pl .card .when { font-weight: 700; font-size: 1.05rem; }
</style>`;
