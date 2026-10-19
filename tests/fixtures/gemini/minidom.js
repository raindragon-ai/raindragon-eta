// A minimal synthetic DOM for the Gemini page-marker tests (the repo has no
// dependencies, so no jsdom). Supports what extension/lib/gemini_dom.js uses:
// querySelector(All) / matches / closest with selector lists, descendant
// combinators, and compounds of tag, #id, .class, [attr], [attr="v"];
// textContent; childNodes / nodeType / nodeValue.
"use strict";

class Text {
  constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)"|='([^']*)')?\]/g;
  let m, pos = 0;
  while ((m = re.exec(s)) && m.index === pos && m[0]) {
    pos = re.lastIndex;
    if (m[1] && m[1] !== "*") c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5] !== undefined ? m[5] : m[6]]);
    re.lastIndex = pos;
    if (pos >= s.length) break;
  }
  if (pos !== s.length) throw new Error("minidom: unsupported selector " + s);
  return c;
}

// Split on `sep` outside [...] (attribute values may hold spaces or commas).
function split(s, sep) {
  const out = [];
  let cur = "", depth = 0;
  for (const ch of s) {
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (depth === 0 && sep.test(ch)) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parse(list) {
  return split(list, /,/).map((s) => split(s.trim(), /\s/).map(parseCompound));
}

function matchCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  const cls = (el.getAttribute("class") || "").split(/\s+/);
  if (c.classes.some((k) => cls.indexOf(k) < 0)) return false;
  for (const [k, v] of c.attrs) {
    if (!el.hasAttribute(k)) return false;
    if (v !== undefined && el.getAttribute(k) !== v) return false;
  }
  return true;
}

function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2, a = el.parentNode;
  while (i >= 0 && a && a.nodeType === 1) {
    if (matchCompound(a, chain[i])) i -= 1;
    a = a.parentNode;
  }
  return i < 0;
}

class Element {
  constructor(tag, attrs, children) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.childNodes = [];
    this.parentNode = null;
    for (const c of children || []) this.appendChild(c);
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) {
    if (typeof c === "string") c = new Text(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  remove() {
    const p = this.parentNode;
    if (p) p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = []; this.appendChild(String(v)); }
  get innerText() { return this.textContent; }
  matches(sel) { return parse(sel).some((ch) => matchChain(this, ch)); }
  closest(sel) {
    for (let e = this; e && e.nodeType === 1; e = e.parentNode) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel) {
    const chains = parse(sel), out = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (chains.some((ch) => matchChain(c, ch))) out.push(c);
        walk(c);
      }
    })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 100, width: 600, height: 50 }; }
}

const h = (tag, attrs, ...children) => new Element(tag, attrs, children.flat());

function doc(...children) {
  const html = h("html", {}, h("body", {}, ...children));
  return { documentElement: html, body: html.childNodes[0],
           querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s) };
}

module.exports = { h, doc, Element, Text };
