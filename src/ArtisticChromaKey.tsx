import { useEffect, useRef, useState } from "react";

function getYoutubeVideoId(url: string): string | null {
  const trimmed = url.trim();
  const m1 = trimmed.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m1 ? m1[1] : null;
}

type CameraDevice = { deviceId: string; label: string };
type UploadedBgVideo = { key: string; name: string; size: number; type: string; createdAt: number };

const BG_DB_NAME = "chroma-key-bg";
const BG_STORE = "videos";

function openBgDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BG_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BG_STORE)) {
        db.createObjectStore(BG_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function bgList(): Promise<UploadedBgVideo[]> {
  const db = await openBgDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, "readonly");
    const store = tx.objectStore(BG_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = (req.result as Array<{ key: string; name: string; size: number; type: string; createdAt: number }>) ?? [];
      resolve(rows.sort((a, b) => a.createdAt - b.createdAt));
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function bgPut(file: File): Promise<UploadedBgVideo> {
  const db = await openBgDb();
  const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const row = { key, name: file.name, size: file.size, type: file.type || "video/*", createdAt: Date.now(), blob: file };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BG_STORE, "readwrite");
    tx.objectStore(BG_STORE).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  const { blob: _blob, ...meta } = row as any;
  return meta as UploadedBgVideo;
}

async function bgGetBlob(key: string): Promise<Blob | null> {
  const db = await openBgDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, "readonly");
    const req = tx.objectStore(BG_STORE).get(key);
    req.onsuccess = () => resolve((req.result as any)?.blob ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function bgRemove(key: string): Promise<void> {
  const db = await openBgDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BG_STORE, "readwrite");
    tx.objectStore(BG_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

declare global {
  interface Window {
    YT?: { Player: new (el: string, opts: object) => { loadVideoById: (id: string) => void; destroy: () => void }; PlayerState: { ENDED: number }; };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export default function ArtisticChromaKey() {
  const userVideoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const ytPlayerRef = useRef<{ loadVideoById: (id: string) => void; destroy: () => void } | null>(null);
  const youtubeIdsRef = useRef<string[]>([]);
  const currentVideoIndexRef = useRef(0);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const [greenThreshold, setGreenThreshold] = useState(120);
  const [similarity, setSimilarity] = useState(1.3);
  const [isRunning, setIsRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cameraRetry, setCameraRetry] = useState(0);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [youtubeUrls, setYoutubeUrls] = useState<string[]>([]);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [newVideoUrl, setNewVideoUrl] = useState("");
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>("");
  const [captureWidth, setCaptureWidth] = useState(640);
  const [captureHeight, setCaptureHeight] = useState(480);
  const [customWidth, setCustomWidth] = useState("640");
  const [customHeight, setCustomHeight] = useState("480");
  const [actualWidth, setActualWidth] = useState(0);
  const [actualHeight, setActualHeight] = useState(0);
  const [uploadedBgVideos, setUploadedBgVideos] = useState<UploadedBgVideo[]>([]);
  const [bgIndex, setBgIndex] = useState(0);
  const bgObjectUrlRef = useRef<string | null>(null);

  const useYoutubeBackground = youtubeUrls.length > 0;
  const useUploadedBackground = !useYoutubeBackground && uploadedBgVideos.length > 0;

  useEffect(() => {
    bgList()
      .then(setUploadedBgVideos)
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Uploaded video varsa onları sırayla oynat
    const v = bgVideoRef.current;
    if (!v) return;

    const cleanupUrl = () => {
      if (bgObjectUrlRef.current) {
        URL.revokeObjectURL(bgObjectUrlRef.current);
        bgObjectUrlRef.current = null;
      }
    };

    const setSource = async () => {
      if (!useUploadedBackground) {
        cleanupUrl();
        v.src = "/videos/vv01.mp4";
        v.loop = true;
        v.muted = true;
        v.play().catch(() => {});
        return;
      }

      const list = uploadedBgVideos;
      const idx = list.length ? bgIndex % list.length : 0;
      const item = list[idx];
      if (!item) return;

      const blob = await bgGetBlob(item.key);
      if (!blob) return;

      cleanupUrl();
      const url = URL.createObjectURL(blob);
      bgObjectUrlRef.current = url;
      v.src = url;
      v.loop = false;
      v.muted = true;
      v.play().catch(() => {});
    };

    void setSource();

    const onEnded = () => {
      if (!useUploadedBackground) return;
      setBgIndex((i) => i + 1);
    };
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("ended", onEnded);
      cleanupUrl();
    };
  }, [useUploadedBackground, uploadedBgVideos, bgIndex]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F9") {
        e.preventDefault();
        setShowSettingsModal((m) => !m);
      }
      if (e.key === "Escape") setShowSettingsModal(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const refreshCameras = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices
          .filter((d) => d.kind === "videoinput")
          .map((d) => ({ deviceId: d.deviceId, label: d.label || "Kamera" }));
        setCameras(vids);
        setSelectedCameraId((prev) => prev || vids[0]?.deviceId || "");
      } catch {
        // enumerateDevices bazı ortamlarda izin olmadan boş dönebilir
      }
    };

    refreshCameras();
    const onDeviceChange = () => refreshCameras();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
  }, []);

  useEffect(() => {
    const startCamera = async () => {
      try {
        // önceki akışı kapat
        if (cameraStreamRef.current) {
          cameraStreamRef.current.getTracks().forEach((t) => t.stop());
          cameraStreamRef.current = null;
        }

        const constraints: MediaStreamConstraints = {
          video: {
            width: { ideal: captureWidth },
            height: { ideal: captureHeight },
            ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
          },
          audio: false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        cameraStreamRef.current = stream;
        setError(null);
        if (userVideoRef.current) {
          userVideoRef.current.srcObject = stream;
          await userVideoRef.current.play();
          // gerçek çözünürlük (kameranın verdiği)
          setActualWidth(userVideoRef.current.videoWidth || 0);
          setActualHeight(userVideoRef.current.videoHeight || 0);
        }
      } catch (err) {
        console.error(err);
        setError("Kamera erişimi alınamadı. İzinleri kontrol edin.");
      }
    };

    startCamera();
    return () => {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
        cameraStreamRef.current = null;
      }
    };
  }, [cameraRetry, selectedCameraId, captureWidth, captureHeight]);

  useEffect(() => {
    const v = userVideoRef.current;
    if (!v) return;
    const onLoaded = () => {
      setActualWidth(v.videoWidth || 0);
      setActualHeight(v.videoHeight || 0);
    };
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("resize", onLoaded);
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("resize", onLoaded);
    };
  }, []);

  useEffect(() => {
    currentVideoIndexRef.current = currentVideoIndex;
  }, [currentVideoIndex]);

  useEffect(() => {
    youtubeIdsRef.current = youtubeUrls.map((u) => getYoutubeVideoId(u)).filter((id): id is string => id != null);
  }, [youtubeUrls]);

  useEffect(() => {
    const bgVideo = bgVideoRef.current;
    if (!bgVideo) return;
    bgVideo.loop = true;
    bgVideo.muted = true;
    bgVideo.play().catch(() => {});
  }, []);

  useEffect(() => {
    if (!useYoutubeBackground || youtubeIdsRef.current.length === 0) return;

    const ids = youtubeIdsRef.current;
    const createPlayer = () => {
      const YT = window.YT;
      if (!YT || !document.getElementById("youtube-bg")) return;
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      const idx = currentVideoIndexRef.current % ids.length;
      const player = new YT.Player("youtube-bg", {
        videoId: ids[idx],
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          showinfo: 0,
          rel: 0,
          loop: 0,
          playlist: ids.join(","),
        },
        events: {
          onStateChange(e: { data: number }) {
            if (e.data === 0) {
              const currentIds = youtubeIdsRef.current;
              if (currentIds.length === 0) return;
              const next = (currentVideoIndexRef.current + 1) % currentIds.length;
              currentVideoIndexRef.current = next;
              setCurrentVideoIndex(next);
              const p = ytPlayerRef.current;
              if (p) p.loadVideoById(currentIds[next]);
            }
          },
        },
      });
      ytPlayerRef.current = player as unknown as { loadVideoById: (id: string) => void; destroy: () => void };
    };

    if (window.YT) {
      createPlayer();
    } else {
      window.onYouTubeIframeAPIReady = () => {
        window.onYouTubeIframeAPIReady = undefined;
        createPlayer();
      };
    }
    return () => {
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
    };
  }, [useYoutubeBackground, youtubeUrls.join(",")]);

  useEffect(() => {
    const video = userVideoRef.current;
    const bgVideo = bgVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !bgVideo || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const drawFrame = () => {
      if (!isRunning) {
        animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        return;
      }

      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;
      if (width === 0 || height === 0) {
        animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        return;
      }

      canvas.width = width;
      canvas.height = height;

      if (!useYoutubeBackground) {
        ctx.drawImage(bgVideo, 0, 0, width, height);
      }

      // Kamerayı ayrı bir yüzeyde çiz, yeşili şeffaflaştır, sonra üstüne composite et
      const off = document.createElement("canvas");
      off.width = width;
      off.height = height;
      const offCtx = off.getContext("2d");
      if (!offCtx) {
        animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      offCtx.drawImage(video, 0, 0, width, height);
      const frame = offCtx.getImageData(0, 0, width, height);
      const data = frame.data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        const isGreen =
          g > greenThreshold &&
          g > r * similarity &&
          g > b * similarity &&
          a > 0;

        if (isGreen) {
          data[i + 3] = 0;
        }
        // Sanatsal dokunuş: glitch / renk kayması burada eklenebilir
      }

      offCtx.putImageData(frame, 0, 0);
      ctx.drawImage(off, 0, 0);

      animationFrameIdRef.current = requestAnimationFrame(drawFrame);
    };

    animationFrameIdRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (animationFrameIdRef.current !== null)
        cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [greenThreshold, similarity, isRunning, useYoutubeBackground]);

  return (
    <div className="fixed inset-0 bg-black">
      {useYoutubeBackground && (
        <div
          id="youtube-bg"
          className="absolute inset-0 z-0 [&>iframe]:w-full [&>iframe]:h-full"
        />
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-10 w-full h-full object-contain block bg-transparent"
      />

      <button
        type="button"
        onClick={() => setShowSettingsModal(true)}
        className="fixed top-3 right-3 z-30 h-10 w-10 rounded-full bg-slate-900/80 border border-slate-700 text-slate-100 shadow-lg backdrop-blur hover:bg-slate-800 active:scale-95 transition md:hidden"
        aria-label="Ayarlar"
        title="Ayarlar"
      >
        ⚙
      </button>

      {showSettingsModal && (
        <>
          <div
            className="fixed inset-0 bg-black/70 z-40"
            onClick={() => setShowSettingsModal(false)}
            aria-hidden
          />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">
                Ayarlar
              </h2>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded"
                aria-label="Kapat"
              >
                ✕
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsRunning((p) => !p)}
              className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition ${
                isRunning
                  ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
                  : "bg-slate-600 hover:bg-slate-500 text-slate-100"
              }`}
            >
              {isRunning ? "Durdur" : "Başlat"}
            </button>

            {error && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-rose-400 bg-rose-950/40 border border-rose-800 rounded-lg px-3 py-2">
                <span className="flex-1 min-w-0">{error}</span>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setCameraRetry((r) => r + 1);
                  }}
                  className="px-3 py-1 rounded-md bg-rose-600 hover:bg-rose-500 text-white font-medium shrink-0"
                >
                  Tekrar dene
                </button>
              </div>
            )}

            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Kamera
              </h3>

              <div className="space-y-2">
                <label className="block text-xs text-slate-300">Kamera seçimi</label>
                <select
                  value={selectedCameraId}
                  onChange={(e) => setSelectedCameraId(e.target.value)}
                  className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm text-slate-200"
                >
                  {cameras.length === 0 ? (
                    <option value="">(Kamera bulunamadı)</option>
                  ) : (
                    cameras.map((c, i) => (
                      <option key={c.deviceId} value={c.deviceId}>
                        {c.label || `Kamera ${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-2">
                <label className="block text-xs text-slate-300">Çözünürlük</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    [320, 240],
                    [640, 480],
                    [854, 480],
                    [1280, 720],
                    [1920, 1080],
                    [2560, 1440],
                  ].map(([w, h]) => {
                    const active = captureWidth === w && captureHeight === h;
                    return (
                      <button
                        key={`${w}x${h}`}
                        type="button"
                        onClick={() => {
                          setCaptureWidth(w);
                          setCaptureHeight(h);
                          setCustomWidth(String(w));
                          setCustomHeight(String(h));
                          setCameraRetry((r) => r + 1);
                        }}
                        className={`px-3 py-2 rounded-lg text-xs border ${
                          active
                            ? "bg-slate-700 border-slate-500 text-white"
                            : "bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700"
                        }`}
                      >
                        {w}×{h}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-slate-300">Özel çözünürlük</label>
                  <div className="flex gap-2">
                    <input
                      inputMode="numeric"
                      value={customWidth}
                      onChange={(e) => setCustomWidth(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="Genişlik"
                      className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm text-slate-200"
                    />
                    <input
                      inputMode="numeric"
                      value={customHeight}
                      onChange={(e) => setCustomHeight(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="Yükseklik"
                      className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const w = Number(customWidth);
                        const h = Number(customHeight);
                        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
                        setCaptureWidth(w);
                        setCaptureHeight(h);
                        setCameraRetry((r) => r + 1);
                      }}
                      className="shrink-0 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium"
                    >
                      Uygula
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      İstek: <span className="tabular-nums">{captureWidth}×{captureHeight}</span>
                    </span>
                    <span>
                      Gerçek:{" "}
                      <span className="tabular-nums">
                        {actualWidth && actualHeight ? `${actualWidth}×${actualHeight}` : "—"}
                      </span>
                    </span>
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Değişiklikler otomatik uygulanır; gerekirse “Tekrar dene” ile yenileyebilirsin.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Arka plan videoları (YouTube)
              </h3>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={newVideoUrl}
                  onChange={(e) => setNewVideoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const id = getYoutubeVideoId(newVideoUrl);
                      if (id) {
                        setYoutubeUrls((u) => [...u, newVideoUrl.trim()]);
                        setNewVideoUrl("");
                      }
                    }
                  }}
                  placeholder="YouTube linki yapıştır"
                  className="flex-1 min-w-0 rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = getYoutubeVideoId(newVideoUrl);
                    if (id) {
                      setYoutubeUrls((u) => [...u, newVideoUrl.trim()]);
                      setNewVideoUrl("");
                    }
                  }}
                  className="shrink-0 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium"
                >
                  Ekle
                </button>
              </div>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {youtubeUrls.map((url, i) => {
                  const id = getYoutubeVideoId(url);
                  return (
                    <li
                      key={`${id}-${i}`}
                      className="flex items-center gap-2 text-xs text-slate-300 bg-slate-800/80 rounded px-2 py-1.5"
                    >
                      <span className="shrink-0 text-slate-500">
                        {i + 1}.
                      </span>
                      <span className="min-w-0 truncate flex-1" title={url}>
                        {id ?? url}
                      </span>
                      {currentVideoIndex % youtubeUrls.length === i && (
                        <span className="shrink-0 text-emerald-400">▶</span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setYoutubeUrls((u) => u.filter((_, j) => j !== i))
                        }
                        className="shrink-0 text-rose-400 hover:text-rose-300"
                        aria-label="Kaldır"
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
              {youtubeUrls.length === 0 && (
                <p className="text-xs text-slate-500">
                  Liste boşken yerel video (vv01.mp4) oynar.
                </p>
              )}
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Arka plan videoları (Dosya)
              </h3>

              <input
                type="file"
                accept="video/*"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length === 0) return;
                  for (const f of files) {
                    try {
                      await bgPut(f);
                    } catch {
                      // ignore
                    }
                  }
                  try {
                    setUploadedBgVideos(await bgList());
                    setBgIndex(0);
                  } catch {
                    // ignore
                  }
                  e.currentTarget.value = "";
                }}
                className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-600"
              />

              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {uploadedBgVideos.map((v, i) => (
                  <li
                    key={v.key}
                    className="flex items-center gap-2 text-xs text-slate-300 bg-slate-800/80 rounded px-2 py-1.5"
                  >
                    <span className="shrink-0 text-slate-500">{i + 1}.</span>
                    <span className="min-w-0 truncate flex-1" title={v.name}>
                      {v.name}
                    </span>
                    {useUploadedBackground && (bgIndex % uploadedBgVideos.length) === i && (
                      <span className="shrink-0 text-emerald-400">▶</span>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        await bgRemove(v.key);
                        const next = await bgList();
                        setUploadedBgVideos(next);
                        setBgIndex(0);
                      }}
                      className="shrink-0 text-rose-400 hover:text-rose-300"
                      aria-label="Sil"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>

              {uploadedBgVideos.length > 0 ? (
                <p className="text-xs text-slate-500">
                  YouTube listesi boşsa, yüklediğin videolar sırayla oynar.
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Not: Web uygulaması çalışırken `public/videos/background` içine dosya yazamaz; bu upload videoları tarayıcıda saklar.
                </p>
              )}
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Chroma
              </h3>
              <div className="space-y-2">
                <label className="flex items-center justify-between text-xs text-slate-300">
                  <span>Yeşil Eşik (G)</span>
                  <span className="tabular-nums text-slate-400">
                    {greenThreshold}
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={255}
                  value={greenThreshold}
                  onChange={(e) => setGreenThreshold(Number(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>
              <div className="space-y-2">
                <label className="flex items-center justify-between text-xs text-slate-300">
                  <span>Benzerlik</span>
                  <span className="tabular-nums text-slate-400">
                    {similarity.toFixed(2)}
                  </span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={2}
                  step={0.05}
                  value={similarity}
                  onChange={(e) => setSimilarity(Number(e.target.value))}
                  className="w-full accent-sky-500"
                />
              </div>
            </div>

            <p className="text-xs text-slate-500">
              F9 ile bu pencereyi açıp kapatabilirsin.
            </p>
          </div>
        </>
      )}

      <video ref={userVideoRef} autoPlay playsInline muted className="hidden" />
      <video
        ref={bgVideoRef}
        autoPlay
        playsInline
        muted
        loop
        src="/videos/vv01.mp4"
        className="hidden"
      />
    </div>
  );
}
