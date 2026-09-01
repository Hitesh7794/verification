// Passive face-guide. Flutter owns the ONE camera (camera_web renders a real <video>
// in the light DOM — confirmed on Flutter 3.41 engine); this script only READS that
// element to run MediaPipe for framing hints + blink detection. No second getUserMedia,
// so no camera-busy collision. Any failure -> __error__ -> the screen's manual fallback.
// Granular [fg] logs so the exact failure point is visible in the console.
(function () {
  let lm = null, running = false, raf = 0, closed = 0, ready = 0, armed = false;

  async function ensure() {
    if (lm) return lm;
    // Self-hosted MediaPipe assets (same origin as the app) — no external CDN dependency,
    // so the FR step loads reliably even when jsdelivr/googleapis are slow or blocked (the
    // cause of "MediaPipe didn't load" for operators returning just for face verification).
    // Absolute /mediapipe/ paths so SPA routes (/kyc/face-match) don't skew the resolution.
    console.log('[fg] importing tasks-vision (self-hosted)…');
    const mod = await import("/mediapipe/vision_bundle.mjs");
    console.log('[fg] import ok — resolving wasm fileset…');
    const fs = await mod.FilesetResolver.forVisionTasks("/mediapipe/wasm");
    console.log('[fg] fileset ok — creating FaceLandmarker…');
    lm = await mod.FaceLandmarker.createFromOptions(fs, {
      baseOptions: {
        modelAssetPath: "/mediapipe/face_landmarker.task",
        delegate: "CPU"
      },
      outputFaceBlendshapes: true, runningMode: "VIDEO", numFaces: 1
    });
    console.log('[fg] FaceLandmarker created');
    return lm;
  }

  // camera_web puts a real <video> in the light DOM; querySelectorAll finds it. We also
  // walk open shadow roots defensively in case a future engine changes the mount point.
  function findVideo() {
    const stack = [document];
    const seen = new Set();
    let fallback = null;
    while (stack.length) {
      const root = stack.pop();
      let vids = [];
      try { vids = root.querySelectorAll('video'); } catch (e) {}
      for (const v of vids) { if (v.videoWidth > 0) return v; if (!fallback) fallback = v; }
      let els = [];
      try { els = root.querySelectorAll('*'); } catch (e) {}
      for (const el of els) { if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); stack.push(el.shadowRoot); } }
    }
    return fallback;
  }

  async function start(onStatus, onBlink) {
    console.log('[fg] start() called');
    running = true; closed = 0; ready = 0; armed = false;
    try { await ensure(); }
    catch (e) { console.error('[fg] MEDIAPIPE FAILED:', e); try { onStatus('__error__', 'error'); } catch (_) {} running = false; return; }

    // Wait up to ~12s for Flutter's camera <video> to be mounted AND playing (videoWidth>0).
    let vid = findVideo(), tries = 0;
    while ((!vid || vid.videoWidth === 0) && tries < 120 && running) {
      await new Promise(r => setTimeout(r, 100)); vid = findVideo(); tries++;
    }
    if (!vid || vid.videoWidth === 0) { console.warn('[fg] NO usable camera video after 12s (found element=' + !!vid + ')'); try { onStatus('__error__', 'error'); } catch (_) {} running = false; return; }
    console.log('[fg] video OK w=' + vid.videoWidth + ' — loop running');

    let last = 0;
    const loop = () => {
      if (!running) return;
      const t = performance.now();
      if (t - last < 60) { raf = requestAnimationFrame(loop); return; }
      last = t;
      let res; try { res = lm.detectForVideo(vid, t); } catch (e) { raf = requestAnimationFrame(loop); return; }
      if (!res.faceLandmarks || !res.faceLandmarks.length) {
        onStatus('center', 'none'); ready = 0; armed = false; closed = 0;
        raf = requestAnimationFrame(loop); return;
      }
      const p = res.faceLandmarks[0];
      let a = 1, b = 0, c = 1, d = 0;
      for (let i = 0; i < p.length; i++) { const x = p[i].x, y = p[i].y; if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y; }
      const cx = (a + b) / 2, cy = (c + d) / 2, h = d - c, offX = Math.abs(cx - 0.5), offY = Math.abs(cy - 0.5);
      // Thresholds retuned for a laptop webcam (~50-70cm sitting distance).
      // The seqr defaults (h>=0.40, offX<=0.15, offY<=0.17) were sized
      // for a phone at arm's length — on a laptop the face is naturally
      // ~20-30% of the frame height, so the old h>=0.40 gate made the
      // ring never turn green until the operator was 15cm from the
      // camera. Loosened bounds fit both a laptop AND a phone.
      let framed = true, st = 'hold';
      if (h < 0.20) { st = 'closer'; framed = false; }
      else if (h > 0.90) { st = 'back'; framed = false; }
      else if (offX > 0.22 || offY > 0.22) { st = 'center'; framed = false; }
      if (framed) { ready = Math.min(ready + 1, 20); armed = ready >= 3; onStatus(armed ? 'blink' : 'hold', armed ? 'ready' : 'ok'); }
      else { ready = 0; armed = false; onStatus(st, 'warn'); }

      if (res.faceBlendshapes && res.faceBlendshapes.length) {
        let l = 0, r = 0; const cats = res.faceBlendshapes[0].categories;
        for (let i = 0; i < cats.length; i++) {
          if (cats[i].categoryName === 'eyeBlinkLeft') l = cats[i].score;
          else if (cats[i].categoryName === 'eyeBlinkRight') r = cats[i].score;
        }
        const bs = (l + r) / 2;
        if (bs > 0.42) { closed++; }
        else {
          if (closed >= 1 && closed <= 12 && armed) {
            // Blink complete (eyes just reopened). Capturing NOW would grab a closed/
            // half-open eye — wait ~420ms for the eyes to be fully open, then fire.
            running = false;
            try { onStatus('hold', 'ready'); } catch (_) {}
            setTimeout(function () { try { onBlink(); } catch (_) {} }, 420);
            return;
          }
          closed = 0;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  // Warm up MediaPipe ahead of time (e.g. while the coaching intro is shown) so blink
  // detection is ready the instant the camera opens — no dead first few seconds.
  async function preload() { try { await ensure(); } catch (_) {} }

  window.seqrFaceGuide = { start, stop, preload };
  console.log('[fg] script loaded, seqrFaceGuide ready');
})();
