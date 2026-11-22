/**
 * Fitly — compress & resize images to an exact size, entirely in the browser.
 *
 * Sections: config · prompt parser · image engine · helpers · state · UI · events
 * No dependencies, no build step, no uploads.
 */
(() => {
  'use strict';

  /* ==========================================================================
     Config
     ========================================================================== */

  const JPEG = 'image/jpeg';
  const WEBP = 'image/webp';
  const SUPPORTS_WEBP = document.createElement('canvas').toDataURL(WEBP).startsWith(`data:${WEBP}`);

  const DEFAULT_QUALITY = 0.9; // used when there is no size limit
  const MAX_QUALITY = 0.95;
  const MIN_QUALITY_FIXED = 0.05; // exact dimensions requested: quality is the only lever
  const MIN_QUALITY_AUTO = 0.45; // free dimensions: shrink pixels before quality gets ugly
  const MIN_SIDE = 16;
  const MAX_SIDE = 10000;

  const RING_LENGTH = 2 * Math.PI * 60; // matches r="60" in index.html
  const MFB_RING_LENGTH = 2 * Math.PI * 18; // matches r="18" in mobile fit bar

  const PRESETS = [
    { name: 'Passport photo', width: 413, height: 531, kb: 50, colors: ['#f6d365', '#fda085'], match: /passport/ },
    { name: 'Signature', width: 140, height: 60, kb: 20, colors: ['#a1c4fd', '#c2e9fb'], match: /signature/ },
    { name: 'Profile picture', width: 400, height: 400, kb: 100, colors: ['#d4fc79', '#96e6a1'], match: /(profile|avatar)/ },
    { name: 'ID scan', width: 800, height: 500, kb: 200, colors: ['#cfd9ff', '#e2c9ff'], match: /(aadhaar|id card|id scan)/ },
    { name: 'Social share', width: 1200, height: 630, kb: 250, colors: ['#fbc2eb', '#a6c1ee'], match: /(social|linkedin|banner)/ },
  ];

  const EXAMPLES = [
    'make this under 10kb, 300x400',
    'passport photo under 50 kb',
    'compress to 20kb as webp',
    'resize to 800 by 600 under 100kb',
  ];

  /* ==========================================================================
     Prompt parser — turns "make this under 10kb, 300x400" into settings
     ========================================================================== */

  /* === parser === */
  function parsePrompt(text) {
    const t = text.toLowerCase();
    const found = { kb: null, width: null, height: null, type: null };

    const preset = PRESETS.find((p) => p.match.test(t));
    if (preset) Object.assign(found, { kb: preset.kb, width: preset.width, height: preset.height });

    const size = t.match(/(\d+(?:\.\d+)?)\s*(kb|mb)/);
    if (size) found.kb = parseFloat(size[1]) * (size[2] === 'mb' ? 1024 : 1);

    const dims = t.match(/(\d{2,5})\s*(?:px)?\s*(?:x|×|\*|by)\s*(\d{2,5})/);
    if (dims) {
      found.width = Number(dims[1]);
      found.height = Number(dims[2]);
    } else {
      const w = t.match(/width\s*[:=]?\s*(\d{2,5})/);
      const h = t.match(/height\s*[:=]?\s*(\d{2,5})/);
      if (w) found.width = Number(w[1]);
      if (h) found.height = Number(h[1]);
    }

    if (/webp/.test(t)) found.type = WEBP;
    else if (/jpe?g/.test(t)) found.type = JPEG;

    found.hasAny = Boolean(found.kb || found.width || found.height || found.type);
    return found;
  }
  /* === /parser === */

  /* ==========================================================================
     Image engine — resize + search for the best quality under a byte limit
     ========================================================================== */

  const toBlob = (canvas, type, quality) =>
    new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  function targetSize(bitmap, width, height) {
    const ratio = bitmap.width / bitmap.height;
    if (width && height) return [width, height];
    if (width) return [width, Math.max(1, Math.round(width / ratio))];
    if (height) return [Math.max(1, Math.round(height * ratio)), height];
    return [bitmap.width, bitmap.height];
  }

  /** Draw the bitmap into a w×h canvas: "crop" fills the frame, "pad" fits inside it on white. */
  function drawTo(bitmap, w, h, fit) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no alpha
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    const pick = fit === 'pad' ? Math.min : Math.max;
    const scale = pick(w / bitmap.width, h / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return canvas;
  }

  /** Binary-search the highest quality whose output stays within maxBytes. */
  async function encodeUnderLimit(canvas, type, maxBytes, minQuality) {
    const floor = await toBlob(canvas, type, minQuality);
    if (floor.size > maxBytes) return { best: null, floor };

    const top = await toBlob(canvas, type, MAX_QUALITY);
    if (top.size <= maxBytes) return { best: { blob: top, quality: MAX_QUALITY } };

    let best = { blob: floor, quality: minQuality };
    let lo = minQuality;
    let hi = MAX_QUALITY;
    for (let i = 0; i < 7; i++) {
      const quality = (lo + hi) / 2;
      const blob = await toBlob(canvas, type, quality);
      if (blob.size <= maxBytes) {
        best = { blob, quality };
        lo = quality;
      } else {
        hi = quality;
      }
    }
    return { best };
  }

  /**
   * Produce a resized, compressed blob.
   * - Both width & height given → dimensions are fixed; only quality moves.
   * - Otherwise → pixels are scaled down as needed to reach the size limit.
   * Returns { blob, width, height, quality, met, scaled }.
   */
  async function compress(bitmap, { width, height, maxBytes, type, fit }) {
    const outType = type === WEBP && !SUPPORTS_WEBP ? JPEG : type;
    const [baseW, baseH] = targetSize(bitmap, width, height);
    const fixed = Boolean(width && height);
    const minQuality = fixed ? MIN_QUALITY_FIXED : MIN_QUALITY_AUTO;
    let scale = 1;

    for (;;) {
      const w = Math.max(1, Math.round(baseW * scale));
      const h = Math.max(1, Math.round(baseH * scale));
      const canvas = drawTo(bitmap, w, h, fit);
      const scaled = scale < 1;

      if (!maxBytes) {
        const blob = await toBlob(canvas, outType, DEFAULT_QUALITY);
        return { blob, width: w, height: h, quality: DEFAULT_QUALITY, met: true, scaled };
      }

      const { best, floor } = await encodeUnderLimit(canvas, outType, maxBytes, minQuality);
      if (best) return { ...best, width: w, height: h, met: true, scaled };

      if (fixed || Math.min(w, h) <= MIN_SIDE) {
        const blob = fixed ? floor : await toBlob(canvas, outType, MIN_QUALITY_FIXED);
        return { blob, width: w, height: h, quality: MIN_QUALITY_FIXED, met: false, scaled };
      }

      // File size scales roughly with pixel count, so jump straight to a good guess.
      const guess = Math.sqrt(maxBytes / floor.size) * 0.92;
      scale *= Math.min(0.9, Math.max(0.25, guess));
    }
  }

  /* ==========================================================================
     Helpers
     ========================================================================== */

  const $ = (id) => document.getElementById(id);

  function fmtBytes(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  const toInt = (v) => {
    const n = parseInt(v, 10);
    return n > 0 ? Math.min(n, MAX_SIDE) : null;
  };
  const toKb = (v) => {
    const n = parseFloat(v);
    return n > 0 ? n : null;
  };
  const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'image';

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /** Re-trigger a one-shot CSS animation class. */
  function replay(el, className, ms = 900) {
    el.classList.remove(className);
    void el.offsetWidth; // force reflow
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), ms);
  }

  /* ==========================================================================
     State & elements
     ========================================================================== */

  const ui = {
    stage: $('stage'), panel: document.querySelector('.panel'), side: document.querySelector('.col-side'), drop: $('drop'), fileInput: $('fileInput'),
    preview: $('preview'), previewImg: $('previewImg'), viewSeg: $('viewSeg'), replace: $('replace'),
    modeSeg: $('modeSeg'), aiPanel: $('aiPanel'), manualPanel: $('manualPanel'),
    aiForm: $('aiForm'), prompt: $('prompt'), understood: $('understood'), addFile: $('addFile'), shuffle: $('shuffle'),
    width: $('width'), height: $('height'), lock: $('lock'), kb: $('kb'), kbRange: $('kbRange'),
    typeSeg: $('typeSeg'), fitSeg: $('fitSeg'), presets: $('presets'),
    meter: $('meter'), ring: $('ringFill'), sizeNow: $('sizeNow'), sizeLimit: $('sizeLimit'),
    statOriginal: $('statOriginal'), statResult: $('statResult'), statDims: $('statDims'), statSaved: $('statSaved'),
    note: $('note'), download: $('download'), toast: $('toast'),
    // Mobile fit bar & sheet controls
    mobileFitBar: $('mobileFitBar'), mfbMeter: $('mfbMeter'), mfbRing: $('mfbRingFill'),
    mfbSizeNow: $('mfbSizeNow'), mfbSizeLimit: $('mfbSizeLimit'), mfbMeta: $('mfbMeta'),
    mfbDetailsBtn: $('mfbDetailsBtn'), mfbDownload: $('mfbDownload'),
    sideClose: $('sideClose'), sheetBackdrop: $('sheetBackdrop'),
  };

  ui.side.setAttribute('aria-hidden', 'true');

  const state = {
    mode: 'ai',
    file: null,
    bitmap: null,
    originalUrl: null,
    resultUrl: null,
    result: null,
    // Single source of truth for both modes. AI prompts fill it in; manual controls edit it.
    settings: { width: null, height: null, kb: null, type: JPEG, fit: 'crop', lock: true },
  };

  let runId = 0; // lets a newer run cancel an older one's animation

  /* ==========================================================================
     UI — generic widgets & mobile sheet
     ========================================================================== */

  let toastTimer;
  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }

  function setSeg(seg, value) {
    const buttons = [...seg.querySelectorAll('button')];
    const index = Math.max(0, buttons.findIndex((b) => b.dataset.value === value));
    seg.style.setProperty('--i', index);
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
  }

  function onSeg(seg, callback) {
    seg.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      setSeg(seg, button.dataset.value);
      callback(button.dataset.value);
    });
  }

  function nudgeDrop() {
    replay(ui.stage, 'nudge', 700);
  }

  function toggleMobileSheet(open) {
    const show = Boolean(open);
    document.body.classList.toggle('sheet-open', show);
    ui.side.classList.toggle('sheet-open', show);
    ui.sheetBackdrop.classList.toggle('open', show);
    ui.mfbDetailsBtn.setAttribute('aria-expanded', String(show));
  }

  function syncPromptRows() {
    ui.prompt.rows = matchMedia('(max-width: 860px)').matches ? 1 : 2;
  }

  /* ==========================================================================
     UI — settings (manual controls + AI prompt feedback)
     ========================================================================== */

  function syncKbControls() {
    const { kb } = state.settings;
    if (kb) ui.kbRange.value = Math.min(500, Math.max(5, kb));
    document.querySelectorAll('[data-kb]').forEach((chip) =>
      chip.classList.toggle('is-active', Number(chip.dataset.kb) === kb));
  }

  /** Programmatic update: writes state and mirrors it into every control. */
  function applySettings(patch) {
    Object.assign(state.settings, patch);
    const s = state.settings;
    ui.width.value = s.width ?? '';
    ui.height.value = s.height ?? '';
    ui.kb.value = s.kb ?? '';
    ui.lock.setAttribute('aria-pressed', String(s.lock));
    setSeg(ui.typeSeg, s.type);
    setSeg(ui.fitSeg, s.fit);
    syncKbControls();
  }

  function renderUnderstood() {
    const p = parsePrompt(ui.prompt.value);
    const tags = [];
    if (p.kb) tags.push(`≤ ${fmtBytes(p.kb * 1024)}`);
    if (p.width && p.height) tags.push(`${p.width} × ${p.height} px`);
    else if (p.width) tags.push(`width ${p.width} px`);
    else if (p.height) tags.push(`height ${p.height} px`);
    if (p.type) tags.push(p.type === WEBP ? 'WebP' : 'JPEG');

    ui.understood.replaceChildren(...tags.map((text) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = text;
      return tag;
    }));
    ui.understood.dataset.empty = String(tags.length === 0);
  }

  function submitPrompt() {
    const parsed = parsePrompt(ui.prompt.value);
    if (!parsed.hasAny) {
      replay(ui.prompt.closest('.prompt'), 'shake', 450);
      toast('Try something like “under 20kb, 300x400”');
      return;
    }
    applySettings({
      width: parsed.width,
      height: parsed.height,
      kb: parsed.kb,
      type: parsed.type ?? JPEG, // a prompt is a full spec: JPEG unless it says otherwise
      lock: !(parsed.width && parsed.height),
    });
    if (!state.bitmap) {
      nudgeDrop();
      toast('Got it — now drop an image');
      return;
    }
    run();
  }

  function usePreset(preset, activeCard) {
    document.querySelectorAll('.preset').forEach((c) => c.classList.remove('is-active'));
    if (activeCard) activeCard.classList.add('is-active');
    applySettings({ width: preset.width, height: preset.height, kb: preset.kb, lock: false, fit: 'crop' });
    ui.prompt.value = `${preset.width}x${preset.height} under ${preset.kb}kb`;
    renderUnderstood();
    if (state.bitmap) run();
    else {
      nudgeDrop();
      toast(`${preset.name} preset ready — drop your image`);
    }
  }

  function renderPresets() {
    const mid = (PRESETS.length - 1) / 2;
    PRESETS.forEach((preset, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset';
      card.style.setProperty('--tilt', (i - mid) * 4);
      card.style.setProperty('--lift', Math.abs(i - mid) * 8);
      card.style.setProperty('--from', preset.colors[0]);
      card.style.setProperty('--to', preset.colors[1]);
      card.innerHTML =
        `<span class="preset-thumb"></span><strong>${preset.name}</strong>` +
        `<small>${preset.width}×${preset.height} · ≤${preset.kb} KB</small>`;
      card.addEventListener('click', () => usePreset(preset, card));
      ui.presets.appendChild(card);
    });
  }

  /** Types example prompts into the placeholder, like a cursor in the field. */
  function startTypewriter(field, lines) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      field.placeholder = lines[0];
      return;
    }
    let line = 0;
    let count = 0;
    let deleting = false;
    const step = () => {
      count += deleting ? -1 : 1;
      field.placeholder = lines[line].slice(0, count);
      let delay = deleting ? 25 : 55;
      if (!deleting && count === lines[line].length) {
        deleting = true;
        delay = 1600;
      } else if (deleting && count === 0) {
        deleting = false;
        line = (line + 1) % lines.length;
        delay = 350;
      }
      setTimeout(step, delay);
    };
    step();
  }

  /* ==========================================================================
     UI — fit meter (desktop ring + mobile compact bar)
     ========================================================================== */

  function setMeterState(name) {
    if (ui.meter.dataset.state !== name) ui.meter.dataset.state = name;
    if (ui.mfbMeter.dataset.state !== name) ui.mfbMeter.dataset.state = name;
  }

  function setRing(fraction) {
    const clamped = Math.min(1, Math.max(0, fraction));
    ui.ring.style.strokeDashoffset = RING_LENGTH * (1 - clamped);
    ui.mfbRing.style.strokeDashoffset = MFB_RING_LENGTH * (1 - clamped);
  }

  function resetMeter(hint = 'drop an image') {
    runId++;
    setMeterState('idle');
    setRing(0);
    ui.sizeNow.textContent = '—';
    ui.sizeLimit.textContent = hint;
    ui.mfbSizeNow.textContent = state.file ? fmtBytes(state.file.size) : '—';
    ui.mfbSizeLimit.textContent = hint;
    ui.mfbMeta.textContent = state.bitmap ? `${state.bitmap.width} × ${state.bitmap.height} px` : '—';
    ui.mfbMeta.classList.remove('warn');
    [ui.statOriginal, ui.statResult, ui.statDims, ui.statSaved].forEach((el) => (el.textContent = '—'));
    ui.note.textContent = '';
    ui.note.classList.remove('warn');
    ui.download.disabled = true;
    ui.mfbDownload.disabled = true;
  }

  /** Counts the size down from the original to the result while the ring settles. */
  function animateMeter({ from, to, limit, met, id }) {
    const start = performance.now();
    const duration = 1100;
    const frame = (now) => {
      if (id !== runId) return;
      const t = Math.min(1, (now - start) / duration);
      const value = from + (to - from) * (1 - Math.pow(1 - t, 3));
      const formatted = fmtBytes(value);
      ui.sizeNow.textContent = formatted;
      ui.mfbSizeNow.textContent = formatted;
      setRing(value / limit);
      if (t < 1) {
        setMeterState(value > limit ? 'over' : 'ok');
        requestAnimationFrame(frame);
      } else {
        setMeterState(met ? 'ok' : 'fail');
        if (met) {
          replay(ui.meter, 'pulse');
          navigator.vibrate?.(14);
        }
      }
    };
    requestAnimationFrame(frame);
  }

  /* ==========================================================================
     Core flow — load → run → present
     ========================================================================== */

  function setView(view) {
    setSeg(ui.viewSeg, view);
    const showResult = view === 'result' && state.resultUrl;
    ui.previewImg.src = showResult ? state.resultUrl : state.originalUrl;
  }

  function revokeUrls() {
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.originalUrl = state.resultUrl = null;
  }

  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('That doesn’t look like an image');
      return;
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      toast('Couldn’t read that image — try JPG, PNG or WebP');
      return;
    }

    state.bitmap?.close?.();
    revokeUrls();
    Object.assign(state, { file, bitmap, result: null });
    state.originalUrl = URL.createObjectURL(file);

    document.body.classList.add('mobile-active');
    ui.stage.classList.add('has-image');
    ui.panel.classList.add('has-image');
    ui.side.setAttribute('aria-hidden', 'false');
    ui.mobileFitBar.setAttribute('aria-hidden', 'false');
    ui.drop.hidden = true;
    ui.preview.hidden = false;
    setView('original');
    resetMeter('set size below');
    ui.statOriginal.textContent = fmtBytes(file.size);

    if (state.mode === 'manual') run();
    else if (ui.prompt.value.trim()) submitPrompt();
  }

  async function run() {
    const { bitmap, file, settings: s } = state;
    if (!bitmap) return;
    if (!s.kb && !s.width && !s.height) {
      resetMeter('set a size or limit');
      ui.statOriginal.textContent = fmtBytes(file.size);
      return;
    }

    const id = ++runId;
    setMeterState('working');
    setRing(0.3);
    ui.sizeNow.textContent = '…';
    ui.sizeLimit.textContent = 'fitting';
    ui.mfbSizeNow.textContent = '…';
    ui.mfbSizeLimit.textContent = 'fitting';
    ui.download.disabled = true;
    ui.mfbDownload.disabled = true;

    const result = await compress(bitmap, { ...s, maxBytes: s.kb ? s.kb * 1024 : null });
    if (id !== runId) return; // a newer run took over

    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.result = result;
    state.resultUrl = URL.createObjectURL(result.blob);
    setView('result');
    present(result, id);
  }

  function present(result, id) {
    const { file, settings: s } = state;
    const size = result.blob.size;
    const limit = s.kb ? s.kb * 1024 : file.size;
    const saved = Math.floor((1 - size / file.size) * 100); // floor: never claim 100%

    const limitText = s.kb ? `/ ${fmtBytes(limit)}` : `of ${fmtBytes(limit)}`;
    ui.sizeLimit.textContent = s.kb ? `of ${fmtBytes(limit)} limit` : `of ${fmtBytes(limit)} original`;
    ui.mfbSizeLimit.textContent = limitText;

    ui.statOriginal.textContent = fmtBytes(file.size);
    ui.statResult.textContent = fmtBytes(size);
    ui.statDims.textContent = `${result.width} × ${result.height}`;
    ui.statSaved.textContent = saved > 0 ? `${saved}%` : '—';
    ui.download.disabled = false;
    ui.mfbDownload.disabled = false;

    ui.note.classList.toggle('warn', !result.met);
    ui.mfbMeta.classList.toggle('warn', !result.met);

    if (!result.met) {
      ui.note.textContent = `Can’t reach ${fmtBytes(limit)} at ${result.width}×${result.height}. This is the smallest it gets — try a higher limit or smaller size.`;
      ui.mfbMeta.textContent = `Min possible at ${result.width}×${result.height}`;
    } else {
      ui.note.textContent = result.scaled
        ? `Scaled down to ${result.width}×${result.height} to hit the limit.`
        : `Quality kept at ${Math.round(result.quality * 100)}%.`;
      const savedPart = saved > 0 ? ` · −${saved}%` : '';
      ui.mfbMeta.textContent = `${result.width}×${result.height}${savedPart}`;
    }

    animateMeter({ from: file.size, to: size, limit, met: result.met, id });
  }

  function download() {
    if (!state.result) return;
    const ext = state.result.blob.type === WEBP ? 'webp' : 'jpg';
    const link = document.createElement('a');
    link.href = state.resultUrl;
    link.download = `${baseName(state.file.name)}-fitly.${ext}`;
    link.click();
  }

  /* ==========================================================================
     Events
     ========================================================================== */

  const runSoon = debounce(run, 220);
  const pickFile = () => ui.fileInput.click();

  // File intake: click, picker, drag & drop, paste
  ui.drop.addEventListener('click', pickFile);
  ui.replace.addEventListener('click', pickFile);
  ui.addFile.addEventListener('click', pickFile);
  ui.fileInput.addEventListener('change', () => {
    loadFile(ui.fileInput.files[0]);
    ui.fileInput.value = ''; // allow re-selecting the same file
  });
  ['dragenter', 'dragover'].forEach((type) =>
    window.addEventListener(type, (e) => {
      e.preventDefault();
      ui.stage.classList.add('is-over');
    }));
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) ui.stage.classList.remove('is-over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.stage.classList.remove('is-over');
    loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) loadFile(file);
  });

  // Mode + preview switches
  onSeg(ui.modeSeg, (mode) => {
    state.mode = mode;
    ui.aiPanel.hidden = mode !== 'ai';
    ui.manualPanel.hidden = mode !== 'manual';
  });
  onSeg(ui.viewSeg, setView);

  // Mobile sheet open/close
  ui.mfbDetailsBtn.addEventListener('click', () => toggleMobileSheet(true));
  ui.sideClose.addEventListener('click', () => toggleMobileSheet(false));
  ui.sheetBackdrop.addEventListener('click', () => toggleMobileSheet(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.side.classList.contains('sheet-open')) toggleMobileSheet(false);
  });
  window.addEventListener('resize', syncPromptRows);

  // AI mode
  ui.aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitPrompt();
  });
  ui.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ui.aiForm.requestSubmit();
    }
  });
  ui.prompt.addEventListener('input', renderUnderstood);
  ui.shuffle.addEventListener('click', () => {
    ui.prompt.value = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
    renderUnderstood();
    ui.prompt.focus();
  });
  document.querySelectorAll('[data-prompt]').forEach((chip) =>
    chip.addEventListener('click', () => {
      ui.prompt.value = chip.dataset.prompt;
      renderUnderstood();
      submitPrompt();
    }));

  // Manual mode
  function onDimInput(key) {
    const value = toInt(ui[key].value);
    state.settings[key] = value;
    if (state.settings.lock && value && state.bitmap) {
      const ratio = state.bitmap.height / state.bitmap.width;
      const other = key === 'width' ? 'height' : 'width';
      const linked = Math.max(1, Math.round(key === 'width' ? value * ratio : value / ratio));
      state.settings[other] = linked;
      ui[other].value = linked;
    }
    runSoon();
  }
  ui.width.addEventListener('input', () => onDimInput('width'));
  ui.height.addEventListener('input', () => onDimInput('height'));
  ui.lock.addEventListener('click', () => {
    state.settings.lock = !state.settings.lock;
    ui.lock.setAttribute('aria-pressed', String(state.settings.lock));
  });
  ui.kb.addEventListener('input', () => {
    state.settings.kb = toKb(ui.kb.value);
    syncKbControls();
    runSoon();
  });
  ui.kbRange.addEventListener('input', () => {
    state.settings.kb = Number(ui.kbRange.value);
    ui.kb.value = ui.kbRange.value;
    syncKbControls();
    runSoon();
  });
  document.querySelectorAll('[data-kb]').forEach((chip) =>
    chip.addEventListener('click', () => {
      applySettings({ kb: Number(chip.dataset.kb) });
      runSoon();
    }));
  onSeg(ui.typeSeg, (type) => {
    state.settings.type = type;
    if (type === WEBP && !SUPPORTS_WEBP) toast('WebP isn’t supported here — using JPEG');
    runSoon();
  });
  onSeg(ui.fitSeg, (fit) => {
    state.settings.fit = fit;
    runSoon();
  });

  ui.download.addEventListener('click', download);
  ui.mfbDownload.addEventListener('click', download);

  /* ==========================================================================
     Init
     ========================================================================== */

  ui.ring.style.strokeDasharray = RING_LENGTH;
  ui.mfbRing.style.strokeDasharray = MFB_RING_LENGTH;
  syncPromptRows();
  applySettings({});
  resetMeter();
  renderPresets();
  renderUnderstood();
  startTypewriter(ui.prompt, EXAMPLES);
})();
