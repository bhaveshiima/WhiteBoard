/**
 * WhiteBoard – Live Teaching Board
 * script.js  |  Modular Canvas Drawing Engine
 *
 * Architecture:
 *   State        – single source of truth for all elements, pages & settings
 *   Pages        – multi-page management with per-page undo/redo stacks
 *   Renderer     – redraws main canvas from State
 *   Tools        – per-tool mousedown/mousemove/mouseup handlers
 *   EventBus     – thin pub/sub for WebSocket-ready collaboration hooks
 *   UI           – wires DOM events → State → Renderer
 */

'use strict';

/* ═══════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════ */
const HANDLE_SIZE = 8;
const MIN_SIZE    = 4;
const GRID_SIZE   = 20;

/* ═══════════════════════════════════════════
   STATE  – single source of truth
════════════════════════════════════════════ */
const State = {
  /* canvas transform */
  pan:  { x: 0, y: 0 },
  zoom: 1,

  /* drawing options */
  tool:        'select',
  strokeColor: '#1a1a2e',
  fillColor:   'transparent',
  fillOpacity: 0.1,
  strokeWidth: 3,
  strokeDash:  'solid',
  opacity:     1,
  fontSize:    18,
  fontFamily:  'sans-serif',
  fontBold:    false,
  fontItalic:  false,

  /* elements on board (always mirrors current page's elements) */
  elements: [],

  /* selection */
  selectedIds: new Set(),

  /* interaction flags */
  isDrawing: false,
  isDragging: false,
  isPanning: false,
  isResizing: false,
  resizeHandle: null,

  /* grid / dark mode */
  showGrid: false,
  darkMode: false,

  /* active sticky color */
  stickyColor: '#ffeaa7',

  /* ── MULTI-PAGE ──
     Each page: { id, name, elements, undoStack, redoStack } */
  pages: [],
  currentPageIdx: 0,

  /* next element id counter (global, never resets) */
  _nextId: 1,
  nextId() { return this._nextId++; },
};

/* ═══════════════════════════════════════════
   EVENT BUS  (WebSocket collaboration-ready)
════════════════════════════════════════════ */
const EventBus = {
  _listeners: {},
  on(event, fn)  { (this._listeners[event] = this._listeners[event] || []).push(fn); },
  off(event, fn) { this._listeners[event] = (this._listeners[event]||[]).filter(f=>f!==fn); },
  emit(event, data) {
    (this._listeners[event]||[]).forEach(fn => fn(data));
    // WebSocket hook: if(window.wsClient) wsClient.send(JSON.stringify({event, data}));
  },
};

/* ═══════════════════════════════════════════
   CANVAS SETUP
════════════════════════════════════════════ */
const container     = document.getElementById('canvas-container');
const mainCanvas    = document.getElementById('main-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const mainCtx       = mainCanvas.getContext('2d');
const overlayCtx    = overlayCanvas.getContext('2d');

function resizeCanvases() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  [mainCanvas, overlayCanvas].forEach(c => {
    c.width  = w;
    c.height = h;
  });
  Renderer.draw();
}

/* ═══════════════════════════════════════════
   COORDINATE HELPERS
════════════════════════════════════════════ */
function screenToWorld(sx, sy) {
  return {
    x: (sx - State.pan.x) / State.zoom,
    y: (sy - State.pan.y) / State.zoom,
  };
}
function worldToScreen(wx, wy) {
  return {
    x: wx * State.zoom + State.pan.x,
    y: wy * State.zoom + State.pan.y,
  };
}
function getPointer(e) {
  const rect = container.getBoundingClientRect();
  let cx, cy;
  if (e.touches) {
    cx = e.touches[0].clientX - rect.left;
    cy = e.touches[0].clientY - rect.top;
  } else {
    cx = e.clientX - rect.left;
    cy = e.clientY - rect.top;
  }
  return screenToWorld(cx, cy);
}

/* ═══════════════════════════════════════════
   ELEMENT FACTORY
════════════════════════════════════════════ */
const createElement = (type, props) => ({
  id:          State.nextId(),
  type,
  x: 0, y: 0,
  w: 0, h: 0,
  strokeColor: State.strokeColor,
  fillColor:   State.fillColor,
  fillOpacity: State.fillOpacity,
  strokeWidth: State.strokeWidth,
  strokeDash:  State.strokeDash,
  opacity:     State.opacity,
  fontSize:    State.fontSize,
  fontFamily:  State.fontFamily,
  fontBold:    State.fontBold,
  fontItalic:  State.fontItalic,
  locked:      false,
  ...props,
});

/* ═══════════════════════════════════════════
   RENDERER
════════════════════════════════════════════ */
const Renderer = {
  draw() {
    const ctx = mainCtx;
    const { width: W, height: H } = mainCanvas;

    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--canvas-bg').trim() || '#fff';
    ctx.fillRect(0, 0, W, H);

    if (State.showGrid) this._drawGrid(ctx, W, H);

    ctx.save();
    ctx.translate(State.pan.x, State.pan.y);
    ctx.scale(State.zoom, State.zoom);

    State.elements.forEach(el => {
      ctx.save();
      ctx.globalAlpha = el.opacity;
      this._drawElement(ctx, el);
      ctx.restore();
    });

    if (State.selectedIds.size > 0) {
      State.selectedIds.forEach(id => {
        const el = getElementById(id);
        if (el) this._drawSelection(ctx, el);
      });
    }

    ctx.restore();
  },

  /* render elements array to a given ctx (used for PDF export) */
  drawElements(ctx, elements, W, H, bgColor) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    elements.forEach(el => {
      ctx.save();
      ctx.globalAlpha = el.opacity;
      this._drawElement(ctx, el);
      ctx.restore();
    });
  },

  _drawGrid(ctx, W, H) {
    const gridColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--grid-color').trim();
    const gs   = GRID_SIZE * State.zoom;
    const offX = ((State.pan.x % gs) + gs) % gs;
    const offY = ((State.pan.y % gs) + gs) % gs;

    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let x = offX - gs; x < W + gs; x += gs) {
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let y = offY - gs; y < H + gs; y += gs) {
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
  },

  _drawElement(ctx, el) {
    switch (el.type) {
      case 'pen':       this._drawPen(ctx, el);       break;
      case 'highlight': this._drawHighlight(ctx, el); break;
      case 'rect':      this._drawRect(ctx, el);      break;
      case 'circle':    this._drawCircle(ctx, el);    break;
      case 'triangle':  this._drawTriangle(ctx, el);  break;
      case 'line':      this._drawLine(ctx, el);      break;
      case 'arrow':     this._drawArrow(ctx, el);     break;
      case 'text':      this._drawText(ctx, el);      break;
      case 'sticky':    this._drawSticky(ctx, el);    break;
      case 'image':     this._drawImage(ctx, el);     break;
    }
  },

  _applyStroke(ctx, el) {
    ctx.strokeStyle = el.strokeColor;
    ctx.lineWidth   = el.strokeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    if (el.strokeDash === 'dashed') {
      ctx.setLineDash([el.strokeWidth * 4, el.strokeWidth * 2]);
    } else if (el.strokeDash === 'dotted') {
      ctx.setLineDash([el.strokeWidth, el.strokeWidth * 2]);
    } else {
      ctx.setLineDash([]);
    }
  },

  _applyFill(ctx, el) {
    if (!el.fillColor || el.fillColor === 'transparent') {
      ctx.fillStyle = 'transparent';
    } else {
      const r = parseInt(el.fillColor.slice(1,3),16);
      const g = parseInt(el.fillColor.slice(3,5),16);
      const b = parseInt(el.fillColor.slice(5,7),16);
      ctx.fillStyle = `rgba(${r},${g},${b},${el.fillOpacity ?? 0.1})`;
    }
  },

  _drawPen(ctx, el) {
    if (!el.points || el.points.length < 2) return;
    this._applyStroke(ctx, el);
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length - 1; i++) {
      const mx = (el.points[i].x + el.points[i+1].x) / 2;
      const my = (el.points[i].y + el.points[i+1].y) / 2;
      ctx.quadraticCurveTo(el.points[i].x, el.points[i].y, mx, my);
    }
    const last = el.points[el.points.length-1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  },

  _drawHighlight(ctx, el) {
    if (!el.points || el.points.length < 2) return;
    ctx.globalAlpha = 0.35 * el.opacity;
    ctx.strokeStyle = el.strokeColor;
    ctx.lineWidth   = el.strokeWidth * 3;
    ctx.lineCap     = 'square';
    ctx.lineJoin    = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) {
      ctx.lineTo(el.points[i].x, el.points[i].y);
    }
    ctx.stroke();
    ctx.globalAlpha = el.opacity;
  },

  _drawRect(ctx, el) {
    this._applyFill(ctx, el);
    this._applyStroke(ctx, el);
    const [x, y, w, h] = normalizeRect(el.x, el.y, el.w, el.h);
    if (ctx.fillStyle !== 'transparent') ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  },

  _drawCircle(ctx, el) {
    this._applyFill(ctx, el);
    this._applyStroke(ctx, el);
    const [x, y, w, h] = normalizeRect(el.x, el.y, el.w, el.h);
    ctx.beginPath();
    ctx.ellipse(x + w/2, y + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, Math.PI*2);
    if (ctx.fillStyle !== 'transparent') ctx.fill();
    ctx.stroke();
  },

  _drawTriangle(ctx, el) {
    this._applyFill(ctx, el);
    this._applyStroke(ctx, el);
    const [x, y, w, h] = normalizeRect(el.x, el.y, el.w, el.h);
    ctx.beginPath();
    ctx.moveTo(x + w/2, y);
    ctx.lineTo(x + w,   y + h);
    ctx.lineTo(x,       y + h);
    ctx.closePath();
    if (ctx.fillStyle !== 'transparent') ctx.fill();
    ctx.stroke();
  },

  _drawLine(ctx, el) {
    this._applyStroke(ctx, el);
    ctx.beginPath();
    ctx.moveTo(el.x,        el.y);
    ctx.lineTo(el.x + el.w, el.y + el.h);
    ctx.stroke();
  },

  _drawArrow(ctx, el) {
    this._applyStroke(ctx, el);
    const x1 = el.x, y1 = el.y;
    const x2 = el.x + el.w, y2 = el.y + el.h;
    const angle   = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(12, el.strokeWidth * 4);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6),
               y2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6),
               y2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.stroke();
  },

  _drawText(ctx, el) {
    if (!el.text) return;
    const weight = el.fontBold   ? 'bold '   : '';
    const style  = el.fontItalic ? 'italic ' : '';
    ctx.font = `${style}${weight}${el.fontSize}px ${el.fontFamily}`;
    ctx.fillStyle    = el.strokeColor;
    ctx.textBaseline = 'top';
    const maxW = el.w || 400;
    const lines = wrapText(ctx, el.text, maxW);
    lines.forEach((line, i) => {
      ctx.fillText(line, el.x, el.y + i * (el.fontSize * 1.35));
    });
  },

  _drawSticky(ctx, el) {
    const pad = 12, r = 6;
    const w = el.w || 180, h = el.h || 140;
    const x = el.x, y = el.y;

    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = el.stickyColor || '#ffeaa7';
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(x + w - 20, y + h);
    ctx.lineTo(x + w,      y + h - 20);
    ctx.lineTo(x + w,      y + h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fill();

    if (el.text) {
      const weight = el.fontBold   ? 'bold '   : '';
      const iStyle = el.fontItalic ? 'italic ' : '';
      ctx.font = `${iStyle}${weight}${el.fontSize || 14}px ${el.fontFamily || 'sans-serif'}`;
      ctx.fillStyle    = '#333';
      ctx.textBaseline = 'top';
      const lines = wrapText(ctx, el.text, w - pad * 2);
      lines.forEach((line, i) => {
        ctx.fillText(line, x + pad, y + pad + i * ((el.fontSize || 14) * 1.4));
      });
    }
  },

  _drawImage(ctx, el) {
    if (!el.img) return;
    ctx.drawImage(el.img, el.x, el.y, el.w, el.h);
  },

  _drawSelection(ctx, el) {
    const bb = getBoundingBox(el);
    if (!bb) return;
    const { x, y, w, h } = bb;
    const pad = 6 / State.zoom;

    ctx.save();
    ctx.strokeStyle = '#5b6af9';
    ctx.lineWidth   = 1.5 / State.zoom;
    ctx.setLineDash([5 / State.zoom, 3 / State.zoom]);
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.setLineDash([]);

    // Resize handles
    getHandlePositions(bb).forEach(hp => {
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = '#5b6af9';
      ctx.lineWidth   = 1.5 / State.zoom;
      const hs = HANDLE_SIZE / State.zoom;
      ctx.fillRect  (hp.x - hs/2, hp.y - hs/2, hs, hs);
      ctx.strokeRect(hp.x - hs/2, hp.y - hs/2, hs, hs);
    });

    // "Double-click to edit" hint badge for text elements
    if (el.type === 'text') {
      const fs     = Math.max(9, 11 / State.zoom);
      const label  = '✎ dbl-click to edit';
      ctx.font     = `${fs}px sans-serif`;
      const tw     = ctx.measureText(label).width;
      const bx     = x + w / 2 - tw / 2 - 4 / State.zoom;
      const by     = y - pad - 18 / State.zoom;
      const bw     = tw + 8 / State.zoom;
      const bh     = 14 / State.zoom;
      ctx.fillStyle    = '#5b6af9';
      ctx.globalAlpha  = 0.85;
      roundRect(ctx, bx, by, bw, bh, 3 / State.zoom);
      ctx.fill();
      ctx.globalAlpha  = 1;
      ctx.fillStyle    = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 4 / State.zoom, by + bh / 2);
    }

    ctx.restore();
  },
};

/* ═══════════════════════════════════════════
   GEOMETRY HELPERS
════════════════════════════════════════════ */
function normalizeRect(x, y, w, h) {
  return [w < 0 ? x + w : x, h < 0 ? y + h : y, Math.abs(w), Math.abs(h)];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function getBoundingBox(el) {
  if (el.type === 'pen' || el.type === 'highlight') {
    if (!el.points || el.points.length === 0) return null;
    const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y);
    const x = Math.min(...xs) - el.strokeWidth;
    const y = Math.min(...ys) - el.strokeWidth;
    return { x, y, w: Math.max(...xs) - x + el.strokeWidth, h: Math.max(...ys) - y + el.strokeWidth };
  }
  if (el.type === 'text') {
    const tmp    = document.createElement('canvas').getContext('2d');
    const weight = el.fontBold   ? 'bold '   : '';
    const style  = el.fontItalic ? 'italic ' : '';
    tmp.font = `${style}${weight}${el.fontSize || 18}px ${el.fontFamily || 'sans-serif'}`;
    const lines = wrapText(tmp, el.text || '', el.w || 600);
    const maxW  = Math.max(...lines.map(l => tmp.measureText(l).width || 0), 60);
    const lineH = (el.fontSize || 18) * 1.4;
    return { x: el.x, y: el.y, w: maxW, h: Math.max(lines.length * lineH, el.fontSize || 18) };
  }
  if (el.type === 'sticky') {
    return { x: el.x, y: el.y, w: el.w || 180, h: el.h || 140 };
  }
  if (el.type === 'line' || el.type === 'arrow') {
    return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h),
             w: Math.abs(el.w) || 4, h: Math.abs(el.h) || 4 };
  }
  const [x, y, w, h] = normalizeRect(el.x, el.y, el.w, el.h);
  return { x, y, w: w || 4, h: h || 4 };
}

function getHandlePositions(bb) {
  const { x, y, w, h } = bb;
  const p = 6;
  return [
    { pos: 'nw', x: x-p,   y: y-p   }, { pos: 'n',  x: x+w/2, y: y-p   },
    { pos: 'ne', x: x+w+p, y: y-p   }, { pos: 'e',  x: x+w+p, y: y+h/2 },
    { pos: 'se', x: x+w+p, y: y+h+p }, { pos: 's',  x: x+w/2, y: y+h+p },
    { pos: 'sw', x: x-p,   y: y+h+p }, { pos: 'w',  x: x-p,   y: y+h/2 },
  ];
}

function hitTestHandle(wx, wy, bb) {
  const thresh = (HANDLE_SIZE + 4) / State.zoom;
  for (const h of getHandlePositions(bb)) {
    if (Math.abs(wx - h.x) < thresh && Math.abs(wy - h.y) < thresh) return h.pos;
  }
  return null;
}

function hitTestElement(el, wx, wy) {
  const bb = getBoundingBox(el);
  if (!bb) return false;
  // Text / sticky get a generous fixed padding so they're easy to click
  const pad = (el.type === 'text' || el.type === 'sticky')
    ? 8
    : Math.max(6, (el.strokeWidth || 4) / 2);
  return wx >= bb.x - pad && wx <= bb.x + bb.w + pad &&
         wy >= bb.y - pad && wy <= bb.y + bb.h + pad;
}

function hitTestAll(wx, wy) {
  for (let i = State.elements.length - 1; i >= 0; i--) {
    if (hitTestElement(State.elements[i], wx, wy)) return State.elements[i];
  }
  return null;
}

function getElementById(id) {
  return State.elements.find(e => e.id === id) || null;
}

function wrapText(ctx, text, maxW) {
  const lines = [];
  (text || '').split('\n').forEach(para => {
    if (!maxW || maxW <= 0) { lines.push(para); return; }
    const words = para.split(' ');
    let line = '';
    words.forEach(word => {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line); line = word;
      } else { line = test; }
    });
    lines.push(line);
  });
  return lines;
}

/* ═══════════════════════════════════════════
   MULTI-PAGE MANAGEMENT
════════════════════════════════════════════ */
function createPage(name) {
  return { id: Date.now() + Math.random(), name, elements: [], undoStack: [], redoStack: [] };
}

/**
 * Flush the live State.elements (and undo stacks) back into the
 * current page object so nothing is lost when switching.
 */
function commitCurrentPage() {
  if (!State.pages.length) return;
  const pg = State.pages[State.currentPageIdx];
  if (!pg) return;
  pg.elements   = State.elements.map(el => ({ ...el, img: el.img || null }));
  pg.undoStack  = [...State.undoStack];
  pg.redoStack  = [...State.redoStack];
}

/** Switch to page at index idx, committing current first */
function switchToPage(idx) {
  if (idx < 0 || idx >= State.pages.length) return;
  commitCurrentPage();

  State.currentPageIdx = idx;
  const pg = State.pages[idx];

  // Restore image objects that can't round-trip through JSON
  State.elements = pg.elements.map(el => {
    if (el.type === 'image' && el._imgSrc && !el.img) {
      const img = new Image();
      img.src = el._imgSrc;
      img.onload = () => Renderer.draw();
      return { ...el, img };
    }
    return { ...el };
  });

  State.undoStack = [...pg.undoStack];
  State.redoStack = [...pg.redoStack];
  State.selectedIds.clear();

  updateUndoButtons();
  renderPagesBar();
  Renderer.draw();
}

function addPage() {
  commitCurrentPage();
  const pg = createPage('Page ' + (State.pages.length + 1));
  State.pages.push(pg);
  switchToPage(State.pages.length - 1);
  showToast('Page ' + State.pages.length + ' added');
}

function deletePage(idx) {
  if (State.pages.length <= 1) { showToast('Cannot delete the only page'); return; }
  if (!confirm(`Delete "${State.pages[idx].name}"?`)) return;
  State.pages.splice(idx, 1);
  const newIdx = Math.min(idx, State.pages.length - 1);
  State.currentPageIdx = newIdx; // point before switchToPage re-commits
  // Force load from the new page
  const pg = State.pages[newIdx];
  State.elements = pg.elements.map(el => {
    if (el.type === 'image' && el._imgSrc && !el.img) {
      const img = new Image();
      img.src = el._imgSrc;
      img.onload = () => Renderer.draw();
      return { ...el, img };
    }
    return { ...el };
  });
  State.undoStack = [...pg.undoStack];
  State.redoStack = [...pg.redoStack];
  State.selectedIds.clear();
  updateUndoButtons();
  renderPagesBar();
  Renderer.draw();
}

function renamePage(idx) {
  const name = prompt('Rename page:', State.pages[idx].name);
  if (name && name.trim()) {
    State.pages[idx].name = name.trim();
    renderPagesBar();
  }
}

/** Rebuild the pages tab bar */
function renderPagesBar() {
  const list = document.getElementById('pages-list');
  list.innerHTML = '';
  State.pages.forEach((pg, i) => {
    const tab = document.createElement('div');
    tab.className = 'page-tab' + (i === State.currentPageIdx ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'page-tab-label';
    label.textContent = pg.name;
    label.title = 'Click to switch • Double-click to rename';
    label.addEventListener('click', () => { if (i !== State.currentPageIdx) switchToPage(i); });
    label.addEventListener('dblclick', () => renamePage(i));

    const del = document.createElement('button');
    del.className = 'page-tab-del';
    del.title = 'Delete page';
    del.innerHTML = '×';
    del.addEventListener('click', e => { e.stopPropagation(); deletePage(i); });

    tab.appendChild(label);
    if (State.pages.length > 1) tab.appendChild(del);
    list.appendChild(tab);
  });
}

/* ═══════════════════════════════════════════
   UNDO / REDO  (per-page stacks)
════════════════════════════════════════════ */
function saveSnapshot() {
  State.undoStack.push(JSON.stringify(State.elements));
  if (State.undoStack.length > 80) State.undoStack.shift();
  State.redoStack = [];
  // keep page in sync
  if (State.pages[State.currentPageIdx]) {
    State.pages[State.currentPageIdx].undoStack = [...State.undoStack];
    State.pages[State.currentPageIdx].redoStack = [];
  }
  updateUndoButtons();
}

function undo() {
  if (!State.undoStack.length) return;
  State.redoStack.push(JSON.stringify(State.elements));
  const snap = State.undoStack.pop();
  restoreSnapshot(snap);
  updateUndoButtons();
}

function redo() {
  if (!State.redoStack.length) return;
  State.undoStack.push(JSON.stringify(State.elements));
  const snap = State.redoStack.pop();
  restoreSnapshot(snap);
  updateUndoButtons();
}

function restoreSnapshot(jsonStr) {
  const raw = JSON.parse(jsonStr);
  State.elements = raw.map(el => {
    if (el.type === 'image' && el._imgSrc) {
      const img = new Image();
      img.src = el._imgSrc;
      return { ...el, img };
    }
    return el;
  });
  // sync back to current page
  if (State.pages[State.currentPageIdx]) {
    State.pages[State.currentPageIdx].elements = [...State.elements];
  }
  State.selectedIds.clear();
  Renderer.draw();
  EventBus.emit('elements:changed', State.elements);
}

function updateUndoButtons() {
  document.getElementById('btn-undo').disabled = State.undoStack.length === 0;
  document.getElementById('btn-redo').disabled = State.redoStack.length === 0;
}

/* ═══════════════════════════════════════════
   PANEL SYNC
   updatePanelFromElement() – called whenever
   the selection changes so that Bold, Italic,
   FontSize, colors etc all reflect the
   selected element's actual stored values.
════════════════════════════════════════════ */
function updatePanelFromElement(el) {
  const fontGroup = document.getElementById('font-group');
  const fillGroup = document.getElementById('fill-group');

  if (!el) {
    // Revert to tool-driven visibility
    const t = State.tool;
    fontGroup.style.display = (t === 'text' || t === 'sticky') ? 'block' : 'none';
    fillGroup.style.display = ['rect','circle','triangle','sticky'].includes(t) ? 'block' : 'none';
    return;
  }

  /* ── Stroke color ── */
  if (el.strokeColor && el.strokeColor !== 'transparent') {
    strokeColorInput.value = el.strokeColor;
  }
  State.strokeColor = el.strokeColor;

  /* ── Fill color + opacity ── */
  if (el.fillColor && el.fillColor !== 'transparent') {
    fillColorInput.value = el.fillColor;
  }
  State.fillColor   = el.fillColor;
  State.fillOpacity = el.fillOpacity ?? 0.1;
  fillOpacityInput.value = State.fillOpacity;
  document.getElementById('fill-opacity-val').textContent =
    Math.round(State.fillOpacity * 100) + '%';

  /* ── Stroke width ── */
  State.strokeWidth = el.strokeWidth || 3;
  strokeSizeInput.value = State.strokeWidth;
  document.getElementById('stroke-size-val').textContent = State.strokeWidth;

  /* ── Stroke dash ── */
  State.strokeDash = el.strokeDash || 'solid';
  document.querySelectorAll('.stroke-style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dash === State.strokeDash);
  });

  /* ── Opacity ── */
  State.opacity = el.opacity ?? 1;
  opacityInput.value = State.opacity;
  document.getElementById('opacity-val').textContent = Math.round(State.opacity * 100);

  /* ── Fill group visibility ── */
  const hasFill = ['rect','circle','triangle','sticky'].includes(el.type);
  fillGroup.style.display = hasFill ? 'block' : 'none';

  /* ── Font group (text & sticky) ── */
  const hasFont = (el.type === 'text' || el.type === 'sticky');
  fontGroup.style.display = hasFont ? 'block' : 'none';

  if (hasFont) {
    /* Font size */
    State.fontSize = el.fontSize || 18;
    fontSizeInput.value = State.fontSize;
    document.getElementById('font-size-val').textContent = State.fontSize;

    /* Font family */
    State.fontFamily = el.fontFamily || 'sans-serif';
    document.getElementById('font-family').value = State.fontFamily;

    /* Bold / Italic toggle buttons */
    State.fontBold   = !!el.fontBold;
    State.fontItalic = !!el.fontItalic;
    document.querySelectorAll('.font-style-btn').forEach(btn => {
      if (btn.dataset.style === 'bold')   btn.classList.toggle('active', State.fontBold);
      if (btn.dataset.style === 'italic') btn.classList.toggle('active', State.fontItalic);
    });
  }
}

/* ═══════════════════════════════════════════
   TOOLS
════════════════════════════════════════════ */

/* ── PEN ── */
const PenTool = {
  current: null,
  onDown(e, wx, wy) {
    saveSnapshot();
    this.current = createElement('pen', { points: [{ x: wx, y: wy }] });
    State.elements.push(this.current);
    State.isDrawing = true;
  },
  onMove(e, wx, wy) {
    if (!State.isDrawing || !this.current) return;
    this.current.points.push({ x: wx, y: wy });
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.save();
    ctx.translate(State.pan.x, State.pan.y);
    ctx.scale(State.zoom, State.zoom);
    ctx.globalAlpha = this.current.opacity;
    Renderer._drawPen(ctx, this.current);
    ctx.restore();
  },
  onUp() {
    State.isDrawing = false;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    Renderer.draw();
    EventBus.emit('element:add', this.current);
    this.current = null;
  },
};

/* ── HIGHLIGHT ── */
const HighlightTool = {
  current: null,
  onDown(e, wx, wy) {
    saveSnapshot();
    this.current = createElement('highlight', { points: [{ x: wx, y: wy }] });
    State.elements.push(this.current);
    State.isDrawing = true;
  },
  onMove(e, wx, wy) {
    if (!State.isDrawing || !this.current) return;
    this.current.points.push({ x: wx, y: wy });
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.save();
    ctx.translate(State.pan.x, State.pan.y);
    ctx.scale(State.zoom, State.zoom);
    Renderer._drawHighlight(ctx, this.current);
    ctx.restore();
  },
  onUp() {
    State.isDrawing = false;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    Renderer.draw();
    EventBus.emit('element:add', this.current);
    this.current = null;
  },
};

/* ── ERASER ── */
const EraserTool = {
  onDown(e, wx, wy) { saveSnapshot(); State.isDrawing = true; this._erase(wx, wy); },
  onMove(e, wx, wy) { if (!State.isDrawing) return; this._erase(wx, wy); },
  onUp()            { State.isDrawing = false; },
  _erase(wx, wy) {
    const r = (State.strokeWidth * 3) / State.zoom;
    const before = State.elements.length;
    State.elements = State.elements.filter(el => {
      const bb = getBoundingBox(el);
      if (!bb) return true;
      return !(wx >= bb.x - r && wx <= bb.x + bb.w + r &&
               wy >= bb.y - r && wy <= bb.y + bb.h + r);
    });
    if (State.elements.length !== before) Renderer.draw();
  },
};

/* ── SHAPE (rect / circle / triangle / line / arrow) ── */
const ShapeTool = {
  current: null, startX: 0, startY: 0,
  onDown(e, wx, wy) {
    saveSnapshot();
    this.startX = wx; this.startY = wy;
    this.current = createElement(State.tool, { x: wx, y: wy, w: 0, h: 0 });
    State.elements.push(this.current);
    State.isDrawing = true;
  },
  onMove(e, wx, wy) {
    if (!State.isDrawing || !this.current) return;
    let dx = wx - this.startX, dy = wy - this.startY;
    if (e.shiftKey) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = dx < 0 ? -side : side;
      dy = dy < 0 ? -side : side;
    }
    this.current.w = dx;
    this.current.h = dy;
    Renderer.draw();
  },
  onUp() {
    State.isDrawing = false;
    const drawn = this.current;
    if (drawn && Math.abs(drawn.w) < MIN_SIZE && Math.abs(drawn.h) < MIN_SIZE) {
      State.elements.pop();
      State.undoStack.pop();
      this.current = null;
      return;
    }
    this.current = null;
    EventBus.emit('element:add', drawn);
    // Auto-switch to Select and select the freshly drawn shape
    if (drawn) switchToSelectTool(drawn);
  },
};

/* ── TEXT ── */
const TextTool = {
  current:      null,   // element being typed into
  _isEditing:   false,  // true = editing an EXISTING element (double-click mode)
  _blurPending: false,  // guard to avoid double-commit on blur+click

  /** Called when user clicks canvas while Text tool is active */
  onDown(e, wx, wy) {
    // If clicking on an existing text element → edit it instead of creating new
    const hit = hitTestAll(wx, wy);
    if (hit && hit.type === 'text') {
      this.cancel();
      this._startEdit(hit);
      return;
    }
    // Commit any in-progress text first, then start a new element
    this.commit();
    const el = createElement('text', { x: wx, y: wy, w: 600, h: 0, text: '' });
    this.current    = el;
    this._isEditing = false;
    this._showInput(el);
  },
  onMove() {},
  onUp()   {},

  /** Open an existing text element for editing (e.g. double-click from Select) */
  _startEdit(el) {
    this.current    = el;
    this._isEditing = true;
    // Activate the Text tool UI without calling setTool (to avoid recursion)
    State.tool = 'text';
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === 'text')
    );
    container.className = 'canvas-container tool-text';
    document.getElementById('font-group').style.display = 'block';
    State.selectedIds.clear();
    this._showInput(el);
    Renderer.draw();
  },

  /** Position and populate the floating textarea */
  _showInput(el) {
    const ta  = document.getElementById('text-input');
    const scr = worldToScreen(el.x, el.y);
    ta.style.display    = 'block';
    ta.style.left       = scr.x + 'px';
    ta.style.top        = scr.y + 'px';
    ta.style.fontSize   = (el.fontSize  * State.zoom) + 'px';
    ta.style.fontFamily = el.fontFamily;
    ta.style.fontWeight = el.fontBold   ? 'bold'   : 'normal';
    ta.style.fontStyle  = el.fontItalic ? 'italic' : 'normal';
    ta.style.color      = el.strokeColor;
    ta.value            = el.text || '';
    ta.style.width      = '200px';
    ta.style.height     = '36px';
    ta.focus();
    // Auto-resize
    ta.oninput = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      ta.style.width  = 'auto';
      ta.style.width  = Math.max(ta.scrollWidth, 80) + 'px';
      // Live preview: update element text while typing
      if (this.current) {
        this.current.text = ta.value;
        if (this._isEditing) Renderer.draw();
      }
    };
    // Trigger once to size correctly for pre-filled text
    ta.oninput();
  },

  /** Finalise the current text and switch back to Select tool */
  commit() {
    const ta = document.getElementById('text-input');
    const txt = ta.value;
    if (this.current && txt.trim()) {
      if (!this._isEditing) {
        // Brand-new element – push it
        saveSnapshot();
        this.current.text = txt;
        const newEl = this.current;
        this.current = null;
        ta.style.display = 'none'; ta.value = '';
        State.elements.push(newEl);
        Renderer.draw();
        EventBus.emit('element:add', newEl);
        // Auto-switch to Select and highlight the new text
        switchToSelectTool(newEl);
        return;
      } else {
        // Editing existing – just update its text
        saveSnapshot();
        this.current.text = txt;
        const edited = this.current;
        this.current = null;
        ta.style.display = 'none'; ta.value = '';
        Renderer.draw();
        switchToSelectTool(edited);
        return;
      }
    }
    // Nothing typed / empty → discard
    ta.style.display = 'none'; ta.value = '';
    this.current    = null;
    this._isEditing = false;
    switchToSelectTool(null);
  },

  /** Discard without saving (Escape) */
  cancel() {
    const ta = document.getElementById('text-input');
    ta.style.display = 'none'; ta.value = '';
    this.current    = null;
    this._isEditing = false;
  },
};

/* ── SELECT ── */
const SelectTool = {
  _dragStart:   { x: 0, y: 0 },
  _elemStart:   [],
  _selRect:     null,
  _resizeStart: null,

  onDown(e, wx, wy) {
    // Check resize handle on single selected element
    if (State.selectedIds.size === 1) {
      const el = getElementById([...State.selectedIds][0]);
      if (el) {
        const bb     = getBoundingBox(el);
        const handle = hitTestHandle(wx, wy, bb);
        if (handle) {
          saveSnapshot();
          State.isResizing   = true;
          State.resizeHandle = handle;
          this._resizeStart  = { wx, wy, el: { ...el }, bb };
          return;
        }
      }
    }

    const hit = hitTestAll(wx, wy);
    if (hit) {
      if (!e.shiftKey && !State.selectedIds.has(hit.id)) {
        State.selectedIds.clear();
      }
      State.selectedIds.add(hit.id);

      /* ── Sync panel to this element's properties ── */
      updatePanelFromElement(hit);

      saveSnapshot();
      State.isDragging = true;
      this._dragStart  = { x: wx, y: wy };
      this._elemStart  = [...State.selectedIds].map(id => {
        const el = getElementById(id);
        return el ? { id, x: el.x, y: el.y, w: el.w, h: el.h,
                      points: el.points ? el.points.map(p => ({...p})) : null } : null;
      }).filter(Boolean);
    } else {
      if (!e.shiftKey) {
        State.selectedIds.clear();
        /* Nothing selected – reset panel to tool defaults */
        updatePanelFromElement(null);
      }
      this._selRect = { x: wx, y: wy, w: 0, h: 0 };
    }
    Renderer.draw();
  },

  onMove(e, wx, wy) {
    if (State.isResizing) { this._doResize(wx, wy); return; }
    if (State.isDragging) {
      const dx = wx - this._dragStart.x;
      const dy = wy - this._dragStart.y;
      this._elemStart.forEach(st => {
        const el = getElementById(st.id);
        if (!el) return;
        el.x = st.x + dx;
        el.y = st.y + dy;
        if (st.points && el.points) {
          el.points = st.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        }
      });
      Renderer.draw();
      return;
    }
    if (this._selRect) {
      this._selRect.w = wx - this._selRect.x;
      this._selRect.h = wy - this._selRect.y;
      Renderer.draw();
      this._drawSelRect();
    }
  },

  onUp(e, wx, wy) {
    if (State.isResizing) { State.isResizing = false; Renderer.draw(); return; }
    if (State.isDragging) {
      State.isDragging = false;
      Renderer.draw();
      EventBus.emit('elements:moved', [...State.selectedIds]);
      return;
    }
    if (this._selRect) {
      const [rx, ry, rw, rh] = normalizeRect(
        this._selRect.x, this._selRect.y,
        this._selRect.w, this._selRect.h
      );
      State.elements.forEach(el => {
        const bb = getBoundingBox(el);
        if (!bb) return;
        if (bb.x >= rx && bb.y >= ry && bb.x + bb.w <= rx + rw && bb.y + bb.h <= ry + rh) {
          State.selectedIds.add(el.id);
        }
      });
      this._selRect = null;
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      // Update panel for first selected element (if any)
      if (State.selectedIds.size > 0) {
        const firstEl = getElementById([...State.selectedIds][0]);
        updatePanelFromElement(firstEl);
      }
      Renderer.draw();
    }
    updateUndoButtons();
  },

  _drawSelRect() {
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.save();
    ctx.translate(State.pan.x, State.pan.y);
    ctx.scale(State.zoom, State.zoom);
    const [x, y, w, h] = normalizeRect(
      this._selRect.x, this._selRect.y,
      this._selRect.w, this._selRect.h
    );
    ctx.strokeStyle = '#5b6af9';
    ctx.lineWidth   = 1.5 / State.zoom;
    ctx.fillStyle   = 'rgba(91,106,249,0.08)';
    ctx.setLineDash([4 / State.zoom]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  },

  _doResize(wx, wy) {
    const { el: orig, bb, wx: sx, wy: sy } = this._resizeStart;
    const el = getElementById(orig.id);
    if (!el) return;
    const dx = wx - sx, dy = wy - sy;
    const h  = State.resizeHandle;
    const nbb = { x: bb.x, y: bb.y, w: bb.w, h: bb.h };
    if (h.includes('e')) nbb.w = Math.max(MIN_SIZE, bb.w + dx);
    if (h.includes('s')) nbb.h = Math.max(MIN_SIZE, bb.h + dy);
    if (h.includes('w')) { nbb.x = bb.x + dx; nbb.w = Math.max(MIN_SIZE, bb.w - dx); }
    if (h.includes('n')) { nbb.y = bb.y + dy; nbb.h = Math.max(MIN_SIZE, bb.h - dy); }
    el.x = nbb.x; el.y = nbb.y; el.w = nbb.w; el.h = nbb.h;
    Renderer.draw();
  },
};

/* ═══════════════════════════════════════════
   HELPER – switch to Select tool and optionally
   auto-select a newly created element.
   Used by all draw tools after they finish.
════════════════════════════════════════════ */
function switchToSelectTool(elToSelect) {
  State.tool = 'select';

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'select');
  });
  container.className = 'canvas-container tool-select';

  State.selectedIds.clear();
  if (elToSelect) {
    State.selectedIds.add(elToSelect.id);
    updatePanelFromElement(elToSelect);
  } else {
    updatePanelFromElement(null);
  }
  Renderer.draw();
}

/* ── PAN tool ── */
const PanTool = {
  last: { x: 0, y: 0 },
  onDown(e, sx, sy) {
    State.isPanning = true;
    this.last = { x: sx, y: sy };
    container.classList.add('tool-panning');
  },
  onMoveScreen(sx, sy) {
    if (!State.isPanning) return;
    State.pan.x += sx - this.last.x;
    State.pan.y += sy - this.last.y;
    this.last = { x: sx, y: sy };
    Renderer.draw();
  },
  onUp() {
    State.isPanning = false;
    container.classList.remove('tool-panning');
  },
};

/* ═══════════════════════════════════════════
   ACTIVE TOOL DISPATCHER
════════════════════════════════════════════ */
function getActiveTool() {
  switch (State.tool) {
    case 'pen':      return PenTool;
    case 'highlight':return HighlightTool;
    case 'eraser':   return EraserTool;
    case 'rect': case 'circle': case 'triangle':
    case 'line': case 'arrow': return ShapeTool;
    case 'text':   return TextTool;
    case 'select': return SelectTool;
    default:       return SelectTool;
  }
}

/* ═══════════════════════════════════════════
   POINTER EVENTS
════════════════════════════════════════════ */
let _spaceDown = false;

function getScreenPointer(e) {
  const rect = container.getBoundingClientRect();
  if (e.touches) {
    return { sx: e.touches[0].clientX - rect.left, sy: e.touches[0].clientY - rect.top };
  }
  return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
}

mainCanvas.addEventListener('mousedown',  onPointerDown);
mainCanvas.addEventListener('mousemove',  onPointerMove);
mainCanvas.addEventListener('mouseup',    onPointerUp);
mainCanvas.addEventListener('mouseleave', onPointerUp);
mainCanvas.addEventListener('touchstart', onPointerDown, { passive: false });
mainCanvas.addEventListener('touchmove',  onPointerMove, { passive: false });
mainCanvas.addEventListener('touchend',   onPointerUp);

/* ── Double-click canvas: re-edit text / quick-create text in Select mode ── */
mainCanvas.addEventListener('dblclick', e => {
  const { sx, sy } = getScreenPointer(e);
  const { x: wx, y: wy } = screenToWorld(sx, sy);
  const hit = hitTestAll(wx, wy);

  if (hit && hit.type === 'text') {
    // Edit existing text element from ANY tool
    State.tool = 'text';
    TextTool._startEdit(hit);
    return;
  }

  // Double-click empty space while in Select → quick text creation
  if (State.tool === 'select' && !hit) {
    setTool('text');
    TextTool.onDown(e, wx, wy);
  }
});

/* ── Textarea: Enter = commit, Shift+Enter = newline, Blur = commit ── */
{
  const ta = document.getElementById('text-input');

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      TextTool.commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      TextTool.cancel();
      switchToSelectTool(null);
    }
  });

  // Commit when focus leaves textarea (e.g. user clicks toolbar/panel)
  ta.addEventListener('blur', () => {
    // Short delay so a toolbar button click registers first
    setTimeout(() => {
      if (TextTool.current) TextTool.commit();
    }, 180);
  });
}

let _lastTouchDist = null;
mainCanvas.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    _lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });
mainCanvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (_lastTouchDist) {
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = container.getBoundingClientRect();
      zoomAt(midX - rect.left, midY - rect.top, dist / _lastTouchDist);
    }
    _lastTouchDist = dist;
  }
}, { passive: true });
mainCanvas.addEventListener('touchend', () => { _lastTouchDist = null; });

function onPointerDown(e) {
  e.preventDefault();
  const { sx, sy } = getScreenPointer(e);
  const { x: wx, y: wy } = screenToWorld(sx, sy);
  if (e.button === 1 || _spaceDown) { PanTool.onDown(e, sx, sy); return; }
  if (e.button === 2) return;
  getActiveTool().onDown(e, wx, wy);
}
function onPointerMove(e) {
  e.preventDefault();
  const { sx, sy } = getScreenPointer(e);
  const { x: wx, y: wy } = screenToWorld(sx, sy);
  if (State.isPanning) { PanTool.onMoveScreen(sx, sy); return; }
  getActiveTool().onMove(e, wx, wy);
}
function onPointerUp(e) {
  const { sx, sy } = getScreenPointer(e.changedTouches
    ? { changedTouches: e.changedTouches } : e);
  const { x: wx, y: wy } = screenToWorld(sx, sy);
  if (State.isPanning) { PanTool.onUp(); return; }
  getActiveTool().onUp(e, wx, wy);
}

mainCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const { sx, sy } = getScreenPointer(e);
  zoomAt(sx, sy, e.deltaY < 0 ? 1.08 : 0.93);
}, { passive: false });

function zoomAt(sx, sy, factor) {
  const newZoom = Math.min(8, Math.max(0.1, State.zoom * factor));
  State.pan.x = sx - (sx - State.pan.x) * (newZoom / State.zoom);
  State.pan.y = sy - (sy - State.pan.y) * (newZoom / State.zoom);
  State.zoom  = newZoom;
  updateZoomDisplay();
  Renderer.draw();
}

/* ── Context menu ── */
mainCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { sx, sy } = getScreenPointer(e);
  const { x: wx, y: wy } = screenToWorld(sx, sy);
  const hit = hitTestAll(wx, wy);
  if (hit) {
    if (!State.selectedIds.has(hit.id)) {
      State.selectedIds.clear();
      State.selectedIds.add(hit.id);
      updatePanelFromElement(hit);
      Renderer.draw();
    }
    showContextMenu(e.clientX, e.clientY);
  } else { hideContextMenu(); }
});

function showContextMenu(x, y) {
  const cm = document.getElementById('context-menu');
  cm.style.display = 'block';
  cm.style.left    = x + 'px';
  cm.style.top     = y + 'px';
}
function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
}
document.addEventListener('click', hideContextMenu);

document.getElementById('ctx-delete').addEventListener('click', deleteSelected);
document.getElementById('ctx-duplicate').addEventListener('click', duplicateSelected);
document.getElementById('ctx-bring-front').addEventListener('click', () => {
  [...State.selectedIds].forEach(id => {
    const idx = State.elements.findIndex(e => e.id === id);
    if (idx !== -1) { const [el] = State.elements.splice(idx, 1); State.elements.push(el); }
  });
  Renderer.draw();
});
document.getElementById('ctx-send-back').addEventListener('click', () => {
  [...State.selectedIds].forEach(id => {
    const idx = State.elements.findIndex(e => e.id === id);
    if (idx !== -1) { const [el] = State.elements.splice(idx, 1); State.elements.unshift(el); }
  });
  Renderer.draw();
});

/* ═══════════════════════════════════════════
   SELECTION HELPERS
════════════════════════════════════════════ */
function deleteSelected() {
  if (!State.selectedIds.size) return;
  saveSnapshot();
  State.elements = State.elements.filter(e => !State.selectedIds.has(e.id));
  State.selectedIds.clear();
  updatePanelFromElement(null);
  Renderer.draw();
}

function duplicateSelected() {
  if (!State.selectedIds.size) return;
  saveSnapshot();
  const copies = [];
  State.selectedIds.forEach(id => {
    const el = getElementById(id);
    if (!el) return;
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = State.nextId();
    copy.x += 20; copy.y += 20;
    if (copy.points) copy.points = copy.points.map(p => ({ x: p.x+20, y: p.y+20 }));
    copies.push(copy);
  });
  State.elements.push(...copies);
  State.selectedIds = new Set(copies.map(c => c.id));
  Renderer.draw();
}

/* ═══════════════════════════════════════════
   KEYBOARD SHORTCUTS
════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;

  const toolMap = {
    'v': 'select', 'p': 'pen',  'h': 'highlight',
    'e': 'eraser', 'r': 'rect', 'c': 'circle',
    'l': 'line',   'a': 'arrow','x': 'text',
    'n': 'sticky', 'i': 'image','t': 'triangle',
  };
  if (!e.ctrlKey && !e.metaKey && toolMap[e.key.toLowerCase()]) {
    setTool(toolMap[e.key.toLowerCase()]); return;
  }
  if ((e.ctrlKey||e.metaKey) && e.key === 'z')            { e.preventDefault(); undo();             return; }
  if ((e.ctrlKey||e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z')))
                                                           { e.preventDefault(); redo();             return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 's')            { e.preventDefault(); AutoSave.save(); showToast('Board saved'); return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'd')            { e.preventDefault(); duplicateSelected();return; }
  if ((e.ctrlKey||e.metaKey) && e.key === 'a')            { e.preventDefault();
    State.selectedIds = new Set(State.elements.map(el => el.id));
    if (State.selectedIds.size === 1) updatePanelFromElement(getElementById([...State.selectedIds][0]));
    Renderer.draw(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') { TextTool.cancel(); State.selectedIds.clear(); updatePanelFromElement(null); Renderer.draw(); return; }
  if (e.key === ' ')      { e.preventDefault(); _spaceDown = true; container.classList.add('tool-pan'); }
  if (e.key === '='||e.key === '+') zoomAt(mainCanvas.width/2, mainCanvas.height/2, 1.1);
  if (e.key === '-')                zoomAt(mainCanvas.width/2, mainCanvas.height/2, 0.9);
  if (e.key === '0')      { State.zoom=1; State.pan={x:0,y:0};
    updateZoomDisplay(); Renderer.draw(); }

  /* ── Arrow-key nudge for selected elements ──
     Normal arrow  = 1 px    (fine positioning)
     Shift + arrow = 10 px   (coarse jump)      */
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    if (!State.selectedIds.size) return;
    e.preventDefault();                           // prevent page scroll
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft'  ? -step
             : e.key === 'ArrowRight' ?  step : 0;
    const dy = e.key === 'ArrowUp'    ? -step
             : e.key === 'ArrowDown'  ?  step : 0;

    // Save undo snapshot once per key-down burst (not on every repeat)
    if (!e.repeat) saveSnapshot();

    State.selectedIds.forEach(id => {
      const el = getElementById(id);
      if (!el) return;
      el.x += dx;
      el.y += dy;
      // Also shift freehand point arrays (pen / highlight)
      if (el.points) el.points = el.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    });
    Renderer.draw();
    return;
  }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') { _spaceDown = false; container.classList.remove('tool-pan'); }
});

/* ═══════════════════════════════════════════
   UI WIRING
════════════════════════════════════════════ */

/* ── setTool ── */
function setTool(tool) {
  // If leaving text tool, discard any uncommitted textarea (commit already
  // auto-switches via switchToSelectTool, so avoid recursion here)
  if (State.tool === 'text' && tool !== 'text') TextTool.cancel();
  State.tool = tool;
  State.selectedIds.clear();

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  container.className = 'canvas-container tool-' + tool;

  // Restore panel to tool defaults (not element)
  updatePanelFromElement(null);

  if (tool === 'image')  document.getElementById('file-load-image').click();
  if (tool === 'sticky') showStickyEditor();

  Renderer.draw();
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

/* ── Color pickers ── */
const strokeColorInput = document.getElementById('stroke-color');
const fillColorInput   = document.getElementById('fill-color');

strokeColorInput.addEventListener('input', e => {
  State.strokeColor = e.target.value;
  applyFontProp({ strokeColor: e.target.value }); // also updates textarea color
});
fillColorInput.addEventListener('input', e => {
  State.fillColor = e.target.value;
  applyToSelected({ fillColor: e.target.value });
});

document.querySelectorAll('.preset').forEach(el => {
  el.addEventListener('click', () => {
    const color = el.dataset.color, target = el.dataset.target;
    if (target === 'stroke') {
      State.strokeColor = color;
      if (color !== 'transparent') strokeColorInput.value = color;
      applyToSelected({ strokeColor: color });
    } else {
      State.fillColor = color;
      if (color !== 'transparent') fillColorInput.value = color;
      applyToSelected({ fillColor: color });
    }
    el.closest('.color-presets').querySelectorAll('.preset').forEach(p => p.classList.remove('selected'));
    el.classList.add('selected');
  });
});

/* ── Stroke width ── */
const strokeSizeInput = document.getElementById('stroke-size');
strokeSizeInput.addEventListener('input', e => {
  State.strokeWidth = +e.target.value;
  document.getElementById('stroke-size-val').textContent = e.target.value;
  applyToSelected({ strokeWidth: +e.target.value });
});

/* ── Stroke style ── */
document.querySelectorAll('.stroke-style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stroke-style-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.strokeDash = btn.dataset.dash;
    applyToSelected({ strokeDash: btn.dataset.dash });
  });
});

/* ── Fill opacity ── */
const fillOpacityInput = document.getElementById('fill-opacity');
fillOpacityInput.addEventListener('input', e => {
  State.fillOpacity = +e.target.value;
  document.getElementById('fill-opacity-val').textContent = Math.round(+e.target.value * 100) + '%';
  applyToSelected({ fillOpacity: +e.target.value });
});

/* ── Opacity ── */
const opacityInput = document.getElementById('opacity');
opacityInput.addEventListener('input', e => {
  State.opacity = +e.target.value;
  document.getElementById('opacity-val').textContent = Math.round(+e.target.value * 100);
  applyToSelected({ opacity: +e.target.value });
});

/* ── Font ──
   These listeners update the live text input textarea immediately
   and also persist the change to any selected element. */
const fontSizeInput = document.getElementById('font-size');

/** Helper: apply font/style props to selected elements AND to in-progress textarea */
function applyFontProp(props) {
  // 1. Apply to any selected elements
  applyToSelected(props);
  // 2. Apply to text element being actively typed (TextTool.current)
  if (TextTool.current) Object.assign(TextTool.current, props);
  // 3. Mirror into the visible textarea
  const ta = document.getElementById('text-input');
  if (ta.style.display !== 'none') {
    if ('fontSize'   in props) ta.style.fontSize   = (props.fontSize * State.zoom) + 'px';
    if ('fontFamily' in props) ta.style.fontFamily = props.fontFamily;
    if ('fontBold'   in props) ta.style.fontWeight = props.fontBold   ? 'bold'   : 'normal';
    if ('fontItalic' in props) ta.style.fontStyle  = props.fontItalic ? 'italic' : 'normal';
    if ('strokeColor' in props) ta.style.color     = props.strokeColor;
  }
}

fontSizeInput.addEventListener('input', e => {
  State.fontSize = +e.target.value;
  document.getElementById('font-size-val').textContent = e.target.value;
  applyFontProp({ fontSize: +e.target.value });
});
document.getElementById('font-family').addEventListener('change', e => {
  State.fontFamily = e.target.value;
  applyFontProp({ fontFamily: e.target.value });
});
document.querySelectorAll('.font-style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    if (btn.dataset.style === 'bold') {
      State.fontBold = btn.classList.contains('active');
      applyFontProp({ fontBold: State.fontBold });
    } else {
      State.fontItalic = btn.classList.contains('active');
      applyFontProp({ fontItalic: State.fontItalic });
    }
  });
});

/** Apply props to all selected elements and redraw */
function applyToSelected(props) {
  if (!State.selectedIds.size) return;
  State.selectedIds.forEach(id => {
    const el = getElementById(id);
    if (el) Object.assign(el, props);
  });
  Renderer.draw();
}

/* ── Undo / Redo ── */
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

/* ── Clear board ── */
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!State.elements.length) return;
  if (confirm('Clear the current page?')) {
    saveSnapshot();
    State.elements = [];
    State.selectedIds.clear();
    Renderer.draw();
    showToast('Page cleared');
  }
});

/* ── Grid ── */
document.getElementById('btn-grid').addEventListener('click', () => {
  State.showGrid = !State.showGrid;
  document.getElementById('btn-grid').classList.toggle('active', State.showGrid);
  Renderer.draw();
});

/* ── Dark mode ── */
document.getElementById('btn-dark').addEventListener('click', () => {
  State.darkMode = !State.darkMode;
  document.documentElement.setAttribute('data-theme', State.darkMode ? 'dark' : 'light');
  document.getElementById('btn-dark').classList.toggle('active', State.darkMode);
  Renderer.draw();
});

/* ── Zoom buttons (toolbar) ── */
document.getElementById('btn-zoom-in').addEventListener('click', ()  => zoomAt(mainCanvas.width/2, mainCanvas.height/2, 1.2));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomAt(mainCanvas.width/2, mainCanvas.height/2, 0.8));
document.getElementById('btn-zoom-reset').addEventListener('click', resetZoom);

/* ── Zoom widget (floating, bottom-left) ── */
document.getElementById('zoom-in-btn').addEventListener('click',  () => zoomAt(mainCanvas.width/2, mainCanvas.height/2, 1.1));
document.getElementById('zoom-out-btn').addEventListener('click', () => zoomAt(mainCanvas.width/2, mainCanvas.height/2, 0.9));
document.getElementById('zoom-indicator').addEventListener('click', resetZoom);

function resetZoom() {
  State.zoom = 1;
  State.pan  = { x: 0, y: 0 };
  updateZoomDisplay();
  Renderer.draw();
}

function updateZoomDisplay() {
  document.getElementById('zoom-indicator').textContent = Math.round(State.zoom * 100) + '%';
}

/* ── Export PNG (current page only) ── */
document.getElementById('btn-save-png').addEventListener('click', () => {
  const saved = State.selectedIds;
  State.selectedIds = new Set();
  Renderer.draw();
  const link = document.createElement('a');
  link.download = 'whiteboard-page' + (State.currentPageIdx + 1) + '-' + Date.now() + '.png';
  link.href = mainCanvas.toDataURL('image/png');
  link.click();
  State.selectedIds = saved;
  Renderer.draw();
  showToast('Page exported as PNG');
});

/* ═══════════════════════════════════════════
   PDF EXPORT  (all pages → single PDF)
   Uses jsPDF loaded from CDN in index.html
════════════════════════════════════════════ */
document.getElementById('btn-save-pdf').addEventListener('click', exportAllPagesPDF);

async function exportAllPagesPDF() {
  if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
    showToast('jsPDF not loaded – check your internet connection');
    return;
  }

  /* Commit the current live page first */
  commitCurrentPage();

  const overlay = document.getElementById('pdf-overlay');
  const status  = document.getElementById('pdf-status');
  overlay.style.display = 'flex';

  /* Offscreen canvas to render each page */
  const W = mainCanvas.width;
  const H = mainCanvas.height;
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = W;
  offCanvas.height = H;
  const offCtx = offCanvas.getContext('2d');

  /* jsPDF – landscape orientation matching canvas aspect ratio */
  const { jsPDF } = window.jspdf || window;
  const orientation = W >= H ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ orientation, unit: 'px', format: [W, H], hotfixes: ['px_scaling'] });

  const bgColor = State.darkMode ? '#2a2b38' : '#ffffff';

  for (let i = 0; i < State.pages.length; i++) {
    status.textContent = `Rendering page ${i + 1} of ${State.pages.length}…`;

    /* Allow UI to update */
    await new Promise(r => setTimeout(r, 30));

    const pg = State.pages[i];

    /* Restore image objects */
    const elements = pg.elements.map(el => {
      if (el.type === 'image' && el._imgSrc && !el.img) {
        const img = new Image();
        img.src = el._imgSrc;
        return { ...el, img };
      }
      return { ...el };
    });

    Renderer.drawElements(offCtx, elements, W, H, bgColor);

    const imgData = offCanvas.toDataURL('image/jpeg', 0.92);

    if (i > 0) pdf.addPage([W, H], orientation);
    pdf.addImage(imgData, 'JPEG', 0, 0, W, H);
  }

  status.textContent = 'Saving PDF…';
  await new Promise(r => setTimeout(r, 30));

  pdf.save('whiteboard-' + Date.now() + '.pdf');

  overlay.style.display = 'none';
  showToast(`PDF exported (${State.pages.length} page${State.pages.length > 1 ? 's' : ''})`);
}

/* ── Save JSON (all pages) ── */
document.getElementById('btn-save-json').addEventListener('click', () => {
  commitCurrentPage();
  const pages = State.pages.map(pg => ({
    ...pg,
    elements: pg.elements.map(el => ({ ...el, img: null })),
    undoStack: [], redoStack: [],  // strip stacks to keep file small
  }));
  const blob = new Blob(
    [JSON.stringify({ version: 2, pages, currentPageIdx: State.currentPageIdx }, null, 2)],
    { type: 'application/json' }
  );
  const link = document.createElement('a');
  link.download = 'whiteboard-' + Date.now() + '.json';
  link.href = URL.createObjectURL(blob);
  link.click();
  showToast('Board saved as JSON');
});

/* ── Load JSON ── */
document.getElementById('btn-load-json').addEventListener('click', () => {
  document.getElementById('file-load-json').click();
});
document.getElementById('file-load-json').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (parsed.version === 2 && parsed.pages) {
        /* Multi-page format */
        State.pages = parsed.pages.map(pg => ({
          ...pg,
          elements: pg.elements || [],
          undoStack: [], redoStack: [],
        }));
        State.currentPageIdx = parsed.currentPageIdx || 0;
        switchToPage(State.currentPageIdx);
      } else {
        /* Legacy single-page format */
        const elements = parsed.elements || parsed;
        commitCurrentPage();
        State.pages[State.currentPageIdx].elements = elements;
        switchToPage(State.currentPageIdx);
      }
      showToast('Board loaded');
    } catch (err) { alert('Invalid JSON file: ' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ── Insert Image ── */
document.getElementById('file-load-image').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) { setTool('select'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const maxW = 400, maxH = 400;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxW) { h = h * maxW / w; w = maxW; }
      if (h > maxH) { w = w * maxH / h; h = maxH; }
      const center = screenToWorld(mainCanvas.width/2, mainCanvas.height/2);
      saveSnapshot();
      const el = createElement('image', {
        x: center.x - w/2, y: center.y - h/2, w, h,
        img, _imgSrc: ev.target.result,
      });
      State.elements.push(el);
      Renderer.draw();
      showToast('Image inserted');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  setTool('select');
  e.target.value = '';
});

/* ── Pages bar ── */
document.getElementById('btn-add-page').addEventListener('click', addPage);

/* ═══════════════════════════════════════════
   STICKY NOTE MODAL
════════════════════════════════════════════ */
function showStickyEditor() {
  document.getElementById('sticky-editor').style.display = 'block';
  document.getElementById('sticky-input').focus();
}
document.querySelectorAll('.sticky-color').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.sticky-color').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    State.stickyColor = el.dataset.color;
  });
});
document.getElementById('sticky-cancel').addEventListener('click', () => {
  document.getElementById('sticky-editor').style.display = 'none';
  document.getElementById('sticky-input').value = '';
  setTool('select');
});
document.getElementById('sticky-ok').addEventListener('click', () => {
  const text = document.getElementById('sticky-input').value.trim();
  document.getElementById('sticky-editor').style.display = 'none';
  document.getElementById('sticky-input').value = '';
  if (text) {
    saveSnapshot();
    const center = screenToWorld(mainCanvas.width/2, mainCanvas.height/2);
    const el = createElement('sticky', {
      x: center.x - 90, y: center.y - 70, w: 180, h: 140,
      text, stickyColor: State.stickyColor,
    });
    State.elements.push(el);
    Renderer.draw();
    showToast('Sticky note added');
  }
  setTool('select');
});

/* ═══════════════════════════════════════════
   TOAST
════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

/* ═══════════════════════════════════════════
   AUTO-SAVE  (localStorage)
   ─────────────────────────────────────────
   • Every change triggers a debounced 2-second
     auto-save to localStorage.
   • Ctrl+S saves immediately.
   • On startup, the last session is restored
     automatically (no prompt needed).
   • A status pill in the menu bar shows:
       ● orange  – unsaved changes
       ◉ grey    – saving…
       ✓ green   – saved (with timestamp)
       ⚠ red     – storage full / error
════════════════════════════════════════════ */
const AutoSave = (() => {
  const KEY          = 'whiteboard_v2_save';
  const DEBOUNCE_MS  = 2000;

  let _timer    = null;   // debounce handle
  let _dirty    = false;  // unsaved changes flag
  let _lastSave = null;   // Date of last successful save

  /* ── Status pill helpers ── */
  function _setStatus(state, text) {
    const dot   = document.getElementById('save-dot');
    const label = document.getElementById('save-label');
    if (!dot || !label) return;
    dot.className   = 'save-dot save-dot--' + state;
    label.textContent = text;
  }

  /* ── Serialise the entire board to a plain object ── */
  function _serialise() {
    commitCurrentPage();   // flush live elements back into current page

    const pages = State.pages.map(pg => ({
      id:   pg.id,
      name: pg.name,
      elements: pg.elements.map(el => {
        // Replace live HTMLImageElement with its cached data-URL
        if (el.type === 'image') return { ...el, img: null };
        return { ...el };
      }),
    }));

    return {
      version:        3,
      pages,
      currentPageIdx: State.currentPageIdx,
      nextId:         State._nextId,
      darkMode:       State.darkMode,
      showGrid:       State.showGrid,
    };
  }

  /* ── Write to localStorage, handle quota errors ── */
  function _write(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      // QuotaExceededError – try a stripped version (drop image data-URLs)
      try {
        const stripped = {
          ...data,
          pages: data.pages.map(pg => ({
            ...pg,
            elements: pg.elements.map(el =>
              el.type === 'image' ? { ...el, _imgSrc: null } : el
            ),
          })),
        };
        localStorage.setItem(KEY, JSON.stringify(stripped));
        showToast('⚠ Images omitted – storage nearly full');
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  /* ── Public: immediate save ── */
  function save() {
    clearTimeout(_timer);
    _setStatus('saving', 'Saving…');
    const data = _serialise();
    const ok   = _write(data);
    if (ok) {
      _dirty    = false;
      _lastSave = new Date();
      _setStatus('saved', 'Saved ' + _timeAgo(_lastSave));
      // Keep the timestamp fresh for a minute
      setTimeout(() => {
        if (!_dirty) _setStatus('saved', 'Saved ' + _timeAgo(_lastSave));
      }, 60_000);
    } else {
      _setStatus('error', '⚠ Storage full');
      showToast('⚠ Could not save – browser storage is full');
    }
  }

  /* ── Public: schedule a debounced save ── */
  function scheduleSave() {
    _dirty = true;
    _setStatus('dirty', 'Unsaved changes');
    clearTimeout(_timer);
    _timer = setTimeout(save, DEBOUNCE_MS);
  }

  /* ── Public: load from localStorage, returns true if data found ── */
  function load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (!data.pages || !data.pages.length) return false;

      // Restore pages
      State.pages = data.pages.map(pg => ({
        id:         pg.id   || Date.now() + Math.random(),
        name:       pg.name || 'Page',
        elements:   (pg.elements || []).map(el => {
          if (el.type === 'image' && el._imgSrc) {
            const img = new Image();
            img.src = el._imgSrc;
            img.onload = () => Renderer.draw();
            return { ...el, img };
          }
          return { ...el };
        }),
        undoStack:  [],
        redoStack:  [],
      }));

      State.currentPageIdx = Math.min(
        data.currentPageIdx || 0,
        State.pages.length - 1
      );
      if (data.nextId) State._nextId = data.nextId;

      // Restore UI toggles
      if (data.darkMode) {
        State.darkMode = true;
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('btn-dark').classList.add('active');
      }
      if (data.showGrid) {
        State.showGrid = true;
        document.getElementById('btn-grid').classList.add('active');
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  /* ── Public: wipe localStorage and reset board ── */
  function clear() {
    localStorage.removeItem(KEY);
    _dirty    = false;
    _lastSave = null;
    _setStatus('saved', 'New board');
  }

  /* ── Helper: human-readable time-ago ── */
  function _timeAgo(date) {
    if (!date) return '';
    const sec = Math.round((Date.now() - date) / 1000);
    if (sec < 5)  return 'just now';
    if (sec < 60) return sec + 's ago';
    return Math.round(sec / 60) + 'm ago';
  }

  return { save, scheduleSave, load, clear };
})();

/* Hook every state-mutation path into AutoSave.scheduleSave()
   so the board is always saved after any real change.           */
const _origSaveSnapshot = saveSnapshot;
// We override the global saveSnapshot to also schedule an auto-save
// (saveSnapshot is already called on every draw-operation commit).
window._autoSaveHooked = true;

/* ── New Board button ── */
document.getElementById('btn-new-board').addEventListener('click', () => {
  if (!confirm('Start a new board? All unsaved changes will be lost.')) return;
  AutoSave.clear();
  // Reset all state
  State.pages         = [];
  State.currentPageIdx= 0;
  State._nextId       = 1;
  State.darkMode      = false;
  State.showGrid      = false;
  document.documentElement.setAttribute('data-theme', 'light');
  document.getElementById('btn-dark').classList.remove('active');
  document.getElementById('btn-grid').classList.remove('active');
  const pg = createPage('Page 1');
  State.pages.push(pg);
  State.elements  = pg.elements;
  State.undoStack = pg.undoStack;
  State.redoStack = pg.redoStack;
  State.selectedIds.clear();
  updateUndoButtons();
  renderPagesBar();
  setTool('select');
  Renderer.draw();
  showToast('New board created');
});

/* ── Manual Save button (also Ctrl+S in keydown handler below) ── */
document.getElementById('btn-save-local').addEventListener('click', () => {
  AutoSave.save();
  showToast('Board saved to browser storage');
});

/* ═══════════════════════════════════════════
   INIT
════════════════════════════════════════════ */
function init() {
  /* ── Try to restore the last session from localStorage ── */
  const restored = AutoSave.load();

  if (restored) {
    // Pages were loaded – wire up the current page's live arrays
    const pg        = State.pages[State.currentPageIdx];
    State.elements  = pg.elements;
    State.undoStack = pg.undoStack;
    State.redoStack = pg.redoStack;
  } else {
    // Fresh start
    const firstPage  = createPage('Page 1');
    State.pages.push(firstPage);
    State.elements   = firstPage.elements;
    State.undoStack  = firstPage.undoStack;
    State.redoStack  = firstPage.redoStack;
  }

  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);

  setTool('select');
  updateUndoButtons();
  renderPagesBar();

  document.getElementById('font-group').style.display = 'none';
  document.getElementById('fill-group').style.display = 'none';

  Renderer.draw();

  /* Set initial save status */
  if (restored) {
    document.getElementById('save-label').textContent = 'Restored';
    document.getElementById('save-dot').className = 'save-dot save-dot--saved';
  } else {
    document.getElementById('save-label').textContent = 'New board';
    document.getElementById('save-dot').className = 'save-dot save-dot--saved';
  }

  /* ── Hook Renderer.draw to schedule auto-save after every render ── */
  const _origDraw = Renderer.draw.bind(Renderer);
  Renderer.draw = function () {
    _origDraw();
    AutoSave.scheduleSave();
  };

  console.log('%cWhiteBoard ready 🎨  (auto-save edition)',
    'color:#5b6af9;font-size:15px;font-weight:700');
  if (restored) console.log('  ↩ Session restored from localStorage');
}

init();

/*
 * WebSocket collaboration hook (template):
 *
 * const ws = new WebSocket('wss://your-server/whiteboard');
 * ws.onopen = () => {
 *   EventBus.on('element:add',       el  => ws.send(JSON.stringify({type:'add',    el})));
 *   EventBus.on('elements:moved',    ids => ws.send(JSON.stringify({type:'move',   ids})));
 *   EventBus.on('elements:changed',  els => ws.send(JSON.stringify({type:'sync',   elements:els})));
 * };
 * ws.onmessage = e => {
 *   const msg = JSON.parse(e.data);
 *   if (msg.type === 'sync') { State.elements = msg.elements; Renderer.draw(); }
 * };
 */
