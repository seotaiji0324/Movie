import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChartBar,
  Check,
  ChatCircle,
  CloudArrowUp,
  Database,
  Eye,
  EyeSlash,
  FolderOpen,
  FilmSlate,
  FloppyDisk,
  ImagesSquare,
  LockKey,
  MagnifyingGlass,
  MapPin,
  MonitorPlay,
  MusicNotes,
  Pause,
  Play,
  Plus,
  ShareNetwork,
  Shapes,
  ShieldCheck,
  SignOut,
  SpeakerHigh,
  SquaresFour,
  TextT,
  Trash,
  UserGear,
  Waveform,
  X,
} from "@phosphor-icons/react";

const assetBase = import.meta.env.BASE_URL || "/";
const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const adminTokenKey = "musecut_admin_session";
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_POSTER_BYTES = 1024 * 1024;

function apiUrl(path) {
  return /^https?:\/\//i.test(path) ? path : `${apiBase}${path}`;
}

function storedAdminToken() {
  try {
    return window.sessionStorage.getItem(adminTokenKey) || "";
  } catch {
    return "";
  }
}

function storeAdminToken(token) {
  try {
    if (token) window.sessionStorage.setItem(adminTokenKey, token);
    else window.sessionStorage.removeItem(adminTokenKey);
  } catch {
    // The HttpOnly cookie remains available when session storage is blocked.
  }
}

function formatDuration(seconds) {
  if (!seconds) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function videoFileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("동영상 첫 화면을 불러오는 시간이 초과되었습니다.")), 12000);
    const finish = (error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("선택한 동영상의 첫 화면을 읽지 못했습니다."));
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("첫 화면 이미지를 만들지 못했습니다."))),
      "image/jpeg",
      quality,
    );
  });
}

async function captureVideoFirstFrame(file) {
  const video = document.createElement("video");
  const source = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    video.src = source;
    video.load();
    await waitForVideoEvent(video, "loadedmetadata");

    const durationSeconds = Math.max(0, Math.round(video.duration) || 0);
    const firstFrameTime = Number.isFinite(video.duration) && video.duration > 0.04
      ? Math.min(0.08, video.duration / 2)
      : 0;

    if (firstFrameTime > 0) {
      video.currentTime = firstFrameTime;
      await waitForVideoEvent(video, "seeked");
    } else if (video.readyState < 2) {
      await waitForVideoEvent(video, "loadeddata");
    }

    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    let posterBlob;

    for (const maxWidth of [960, 720, 560]) {
      const scale = Math.min(1, maxWidth / sourceWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("첫 화면 이미지를 처리할 수 없습니다.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.86, 0.72, 0.58]) {
        posterBlob = await canvasToJpeg(canvas, quality);
        if (posterBlob.size <= MAX_POSTER_BYTES) break;
      }
      if (posterBlob.size <= MAX_POSTER_BYTES) break;
    }

    if (!posterBlob || posterBlob.size > MAX_POSTER_BYTES) {
      throw new Error("첫 화면 이미지가 1MB를 초과했습니다.");
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "video";
    return {
      dataUrl: await fileToDataUrl(posterBlob),
      durationSeconds,
      fileKey: videoFileKey(file),
      fileName: `${baseName}-first-frame.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: posterBlob.size,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(source);
  }
}

function versionedMediaUrl(path, assetVersion) {
  return `${apiUrl(path)}?v=${encodeURIComponent(String(assetVersion))}`;
}

function mapDatabasePost(post, assetVersion = Date.now()) {
  return {
    id: post.id,
    category: post.category,
    title: post.title,
    location: post.location,
    date: post.recordedAt ? String(post.recordedAt).slice(0, 10).replaceAll("-", ".") : "오늘",
    duration: formatDuration(Number(post.durationSeconds)),
    caption: post.caption,
    assetVersion,
    posterUrl: post.hasPoster
      ? versionedMediaUrl(`/api/videos/${post.id}/poster`, assetVersion)
      : `${assetBase}assets/poster-ocean.png`,
    videoUrl: versionedMediaUrl(`/api/videos/${post.id}/content`, assetVersion),
    color: "rose",
  };
}

async function jsonRequest(url, options = {}) {
  const token = storedAdminToken();
  const response = await fetch(apiUrl(url), {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "요청을 처리하지 못했습니다.");
  return payload;
}

function AdminVideoEditor({ video, categories, onSaved, onDeleted, setToast }) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [replacementPoster, setReplacementPoster] = useState(null);
  const [generatingPoster, setGeneratingPoster] = useState(false);

  async function handleReplacementChange(event) {
    const file = event.target.files?.[0];
    setReplacementPoster(null);
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) {
      event.target.value = "";
      setToast("교체 동영상은 50MB 이하 파일만 사용할 수 있습니다.");
      return;
    }

    setGeneratingPoster(true);
    try {
      setReplacementPoster(await captureVideoFirstFrame(file));
    } catch (error) {
      event.target.value = "";
      setToast(error.message || "교체 동영상의 첫 화면을 만들지 못했습니다.");
    } finally {
      setGeneratingPoster(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const replacementFile = formData.get("replacementVideo");
    if (replacementFile instanceof File && replacementFile.size > MAX_VIDEO_BYTES) {
      setToast("교체 동영상은 50MB 이하 파일만 사용할 수 있습니다.");
      return;
    }
    setSaving(true);
    try {
      const requestBody = {
        title: String(formData.get("title") || ""),
        caption: String(formData.get("caption") || ""),
        category: String(formData.get("category") || categories[0] || "기타"),
        location: String(formData.get("location") || ""),
        recordedAt: String(formData.get("recordedAt") || ""),
        isPublished: formData.get("isPublished") === "on",
      };
      if (replacementFile instanceof File && replacementFile.size) {
        const generatedPoster = replacementPoster?.fileKey === videoFileKey(replacementFile)
          ? replacementPoster
          : await captureVideoFirstFrame(replacementFile);
        requestBody.videoFileName = replacementFile.name;
        requestBody.durationSeconds = generatedPoster.durationSeconds;
        requestBody.videoDataUrl = await fileToDataUrl(replacementFile);
        requestBody.posterFileName = generatedPoster.fileName;
        requestBody.posterMimeType = generatedPoster.mimeType;
        requestBody.posterDataUrl = generatedPoster.dataUrl;
      }
      const payload = await jsonRequest(`/api/admin/videos/${video.id}`, {
        method: "PATCH",
        body: JSON.stringify(requestBody),
      });
      onSaved(payload.video);
      const replacementInput = form.elements.namedItem("replacementVideo");
      if (replacementInput) replacementInput.value = "";
      setReplacementPoster(null);
      setToast(
        replacementFile instanceof File && replacementFile.size
          ? "새 동영상과 첫 화면 표지가 MOVIEDB에 반영되었습니다."
          : "관리자 수정 내용이 MOVIEDB에 반영되었습니다.",
      );
    } catch (error) {
      setToast(error.message || "영상 정보를 수정하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await jsonRequest(`/api/admin/videos/${video.id}`, { method: "DELETE" });
      onDeleted(video.id);
      setToast(`‘${video.title}’ 영상이 MOVIEDB에서 삭제되었습니다.`);
    } catch (error) {
      setToast(error.message || "영상을 삭제하지 못했습니다.");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const posterUrl = replacementPoster?.dataUrl || (video.hasPoster && video.isPublished
    ? versionedMediaUrl(`/api/videos/${video.id}/poster`, video.assetVersion || video.createdAt)
    : `${assetBase}assets/poster-ocean.png`);

  return (
    <form className="admin-video-editor" onSubmit={handleSave}>
      <div className="admin-video-preview">
        <img src={posterUrl} alt={`${video.title} 영상 표지`} />
        <span>{formatDuration(Number(video.durationSeconds))}</span>
      </div>
      <div className="admin-video-fields">
        <div className="admin-video-heading">
          <div className="admin-editor-label">
            <span className={`publish-badge ${video.isPublished ? "published" : "hidden"}`}>
              {video.isPublished ? <Eye size={14} /> : <EyeSlash size={14} />}
              {video.isPublished ? "공개" : "비공개"}
            </span>
            <strong>게시글 수정</strong>
          </div>
          <small>{(Number(video.videoSizeBytes) / 1024 / 1024).toFixed(1)} MB</small>
        </div>
        <div className="field-row">
          <label><span>작품명</span><input name="title" required defaultValue={video.title} /></label>
          <label><span>촬영 장소</span><input name="location" required defaultValue={video.location} /></label>
        </div>
        <div className="field-row">
          <label><span>영상 콘셉트</span><select name="category" defaultValue={video.category} disabled={!categories.length}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label><span>촬영일</span><input name="recordedAt" type="date" defaultValue={String(video.recordedAt || "").slice(0, 10)} /></label>
        </div>
        <label><span>작품 소개</span><textarea name="caption" rows="2" defaultValue={video.caption} /></label>
        <label className="admin-replacement-video">
          <span>뮤직비디오 파일 교체</span>
          <span className="replacement-picker">
            <CloudArrowUp size={19} weight="duotone" />
            <span><strong>{replacementPoster ? replacementPoster.fileName : video.videoFileName}</strong><small>{generatingPoster ? "첫 화면 표지 만드는 중..." : "새 영상 선택 시 첫 화면 표지도 자동 갱신 · 최대 50MB"}</small></span>
            <input name="replacementVideo" type="file" accept="video/mp4,video/webm,video/*" onChange={handleReplacementChange} />
          </span>
        </label>
        <div className="admin-video-actions">
          <label className="publish-toggle">
            <input name="isPublished" type="checkbox" defaultChecked={video.isPublished} />
            <span>스튜디오 화면에 공개</span>
          </label>
          <div className="admin-action-buttons">
            <button className="delete-button" type="button" onClick={() => setConfirmingDelete(true)} disabled={saving || deleting}>
              <Trash size={16} weight="bold" />게시글 삭제
            </button>
            <button className="save-button" type="submit" disabled={saving || deleting || generatingPoster || !categories.length}>
              <FloppyDisk size={16} weight="bold" />
              {saving ? "저장 중..." : "게시글 수정 저장"}
            </button>
          </div>
        </div>
        {confirmingDelete && (
          <div className="delete-confirmation" role="alert">
            <p><strong>‘{video.title}’ 게시글을 영구 삭제할까요?</strong><span>게시글 정보와 영상 파일의 Snowflake 청크가 함께 삭제되며 복구할 수 없습니다.</span></p>
            <div>
              <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting}>취소</button>
              <button className="confirm-delete-button" type="button" onClick={handleDelete} disabled={deleting}>{deleting ? "삭제 중..." : "영구 삭제"}</button>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}

function AdminModal({ session, categories, onSessionChange, onClose, refreshPublicVideos, setToast }) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadAdminVideos = useCallback(async () => {
    if (!session.authenticated) return;
    setLoading(true);
    try {
      const payload = await jsonRequest("/api/admin/videos", { cache: "no-store" });
      const assetVersion = Date.now();
      setVideos(Array.isArray(payload.videos)
        ? payload.videos.map((video) => ({ ...video, assetVersion }))
        : []);
    } catch (error) {
      setToast(error.message || "관리자 영상 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [session.authenticated, setToast]);

  useEffect(() => {
    loadAdminVideos();
  }, [loadAdminVideos]);

  async function handleAccess(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") || "");
    const passwordConfirm = String(formData.get("passwordConfirm") || "");
    if (session.setupRequired && password !== passwordConfirm) {
      setToast("비밀번호 확인 값이 일치하지 않습니다.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = await jsonRequest(session.setupRequired ? "/api/admin/setup" : "/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: "SEOHYUNHO", password }),
      });
      storeAdminToken(payload.sessionToken);
      onSessionChange({ checked: true, ...payload });
      setToast(session.setupRequired ? "SEOHYUNHO 관리자 설정이 완료되었습니다." : "관리자로 로그인했습니다.");
    } catch (error) {
      setToast(error.message || "관리자 인증에 실패했습니다.");
    } finally {
      setSubmitting(false);
      event.currentTarget?.reset();
    }
  }

  async function handleLogout() {
    try {
      const payload = await jsonRequest("/api/admin/logout", { method: "POST" });
      storeAdminToken("");
      onSessionChange({ checked: true, setupRequired: false, ...payload });
      setVideos([]);
      setToast("관리자 로그아웃이 완료되었습니다.");
    } catch (error) {
      setToast(error.message || "로그아웃하지 못했습니다.");
    }
  }

  async function handleSaved(savedVideo) {
    const assetVersion = Date.now();
    setVideos((current) => current.map((video) => (
      video.id === savedVideo.id ? { ...savedVideo, assetVersion } : video
    )));
    await refreshPublicVideos();
  }

  async function handleDeleted(videoId) {
    setVideos((current) => current.filter((video) => video.id !== videoId));
    await refreshPublicVideos();
  }

  const publishedCount = videos.filter((video) => video.isPublished).length;

  return (
    <div className="modal-backdrop admin-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`admin-modal ${session.authenticated ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <button className="modal-close dark" type="button" onClick={onClose} aria-label="관리자 메뉴 닫기"><X size={20} /></button>
        <div className="admin-title">
          <span><ShieldCheck size={24} weight="duotone" /></span>
          <div>
            <p>MEMBER · ADMIN</p>
            <h2 id="admin-title">뮤직비디오 관리자</h2>
          </div>
          {session.authenticated && (
            <button className="logout-button" type="button" onClick={handleLogout}><SignOut size={15} />로그아웃</button>
          )}
        </div>
        <div className="admin-category-source" aria-label="CATEGORY 테이블 카테고리">
          <Database size={15} weight="duotone" />
          <strong>CATEGORY DB</strong>
          {categories.map((category) => <span key={category}>{category}</span>)}
        </div>

        {!session.checked && <div className="admin-loading">관리자 상태를 확인하는 중입니다.</div>}

        {session.checked && !session.authenticated && (
          <div className="admin-access">
            <div className="admin-access-copy">
              <LockKey size={28} weight="duotone" />
              <h3>{session.setupRequired ? "최초 관리자 비밀번호 설정" : "관리자 로그인"}</h3>
              <p>관리자 이름은 <strong>SEOHYUNHO</strong>로 고정됩니다. 로그인 후 게시글 수정, 영상 교체, 공개 상태 변경과 2단계 영구 삭제를 사용할 수 있습니다.</p>
            </div>
            <form onSubmit={handleAccess}>
              <label><span>관리자 이름</span><input name="username" value="SEOHYUNHO" readOnly /></label>
              <label><span>비밀번호</span><input name="password" type="password" minLength="12" maxLength="128" required autoComplete={session.setupRequired ? "new-password" : "current-password"} placeholder="12자 이상 입력" /></label>
              {session.setupRequired && (
                <label><span>비밀번호 확인</span><input name="passwordConfirm" type="password" minLength="12" maxLength="128" required autoComplete="new-password" placeholder="같은 비밀번호 다시 입력" /></label>
              )}
              <button className="admin-submit" type="submit" disabled={submitting}>
                {submitting ? "확인 중..." : session.setupRequired ? "SEOHYUNHO 관리자 설정" : "관리자 로그인"}
              </button>
            </form>
          </div>
        )}

        {session.checked && session.authenticated && (
          <div className="admin-panel">
            <div className="admin-workspace-banner">
              <div>
                <span>ADMIN WORKSPACE</span>
                <h3>게시글 수정 및 삭제</h3>
              </div>
              <p>변경 내용은 MOVIEDB와 뮤직비디오 스튜디오 화면에 바로 반영됩니다.</p>
            </div>
            <div className="admin-summary">
              <div><span>관리자</span><strong>SEOHYUNHO</strong></div>
              <div><span>전체 작품</span><strong>{String(videos.length).padStart(2, "0")}</strong></div>
              <div><span>공개 작품</span><strong>{String(publishedCount).padStart(2, "0")}</strong></div>
            </div>
            {loading && <div className="admin-loading">MOVIEDB 영상 목록을 불러오는 중입니다.</div>}
            {!loading && !videos.length && <div className="admin-loading">관리할 뮤직비디오가 없습니다.</div>}
            {!loading && videos.map((video) => (
              <AdminVideoEditor key={video.id} video={video} categories={categories} onSaved={handleSaved} onDeleted={handleDeleted} setToast={setToast} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function App() {
  const [posts, setPosts] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [categoriesChecked, setCategoriesChecked] = useState(false);
  const [activePost, setActivePost] = useState(null);
  const [filter, setFilter] = useState("전체");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTool, setActiveTool] = useState("media");
  const [timelineZoom, setTimelineZoom] = useState(58);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminSession, setAdminSession] = useState({
    checked: false,
    authenticated: false,
    setupRequired: false,
    username: "SEOHYUNHO",
  });
  const [dbConnected, setDbConnected] = useState(false);
  const [dbChecked, setDbChecked] = useState(false);
  const [dbMessage, setDbMessage] = useState("");
  const [toast, setToast] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadPoster, setUploadPoster] = useState(null);
  const [posterGenerating, setPosterGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef(null);

  const refreshPublicVideos = useCallback(async (signal) => {
    try {
      const response = await fetch(apiUrl("/api/videos"), { signal, cache: "no-store", credentials: "include" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "MOVIEDB 영상을 불러오지 못했습니다.");
      const connected = Boolean(payload.connected);
      const assetVersion = Date.now();
      setDbConnected(connected);
      setPosts(connected && Array.isArray(payload.videos)
        ? payload.videos.map((video) => mapDatabasePost(video, assetVersion))
        : []);
      setDbMessage(connected ? "" : "Snowflake MOVIEDB 연결이 필요합니다.");
    } catch (error) {
      if (error.name !== "AbortError") {
        setDbConnected(false);
        setPosts([]);
        setDbMessage(error.message || "Snowflake MOVIEDB 연결이 필요합니다.");
      }
    } finally {
      if (!signal?.aborted) setDbChecked(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshPublicVideos(controller.signal);
    jsonRequest("/api/categories", { signal: controller.signal })
      .then((payload) => {
        setCategoryOptions(Array.isArray(payload.categories) ? payload.categories : []);
        setCategoriesChecked(true);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setCategoryOptions([]);
          setCategoriesChecked(true);
          setToast(error.message || "MOVIEDB 카테고리를 불러오지 못했습니다.");
        }
      });
    jsonRequest("/api/admin/session", { signal: controller.signal })
      .then((payload) => setAdminSession({ checked: true, ...payload }))
      .catch((error) => {
        if (error.name !== "AbortError") {
          setAdminSession((current) => ({ ...current, checked: true }));
        }
      });
    return () => controller.abort();
  }, [refreshPublicVideos]);

  useEffect(() => {
    if (filter !== "전체" && !categoryOptions.includes(filter)) setFilter("전체");
  }, [categoryOptions, filter]);

  useEffect(() => {
    setActivePost((current) => (
      current ? posts.find((post) => post.id === current.id) || null : current
    ));
  }, [posts]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setActivePost(null);
        setUploadOpen(false);
        setUploadPoster(null);
        setAdminOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const visiblePosts = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase("ko");
    return posts.filter((post) => {
      const categoryMatches = filter === "전체" || post.category === filter;
      const searchMatches = !query || [post.title, post.caption, post.location, post.category]
        .some((value) => String(value || "").toLocaleLowerCase("ko").includes(query));
      return categoryMatches && searchMatches;
    });
  }, [filter, posts, searchTerm]);

  const featuredPost = activePost || visiblePosts[0] || posts[0] || null;
  const libraryGroups = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase("ko");
    return categoryOptions
      .map((category) => ({
        category,
        items: posts.filter((post) => post.category === category && (
          !query || [post.title, post.caption, post.location, post.category]
            .some((value) => String(value || "").toLocaleLowerCase("ko").includes(query))
        )),
      }))
      .filter((group) => group.items.length);
  }, [categoryOptions, posts, searchTerm]);

  function openPlayer(post) {
    playerRef.current?.pause();
    setActivePost(post);
    setIsPlaying(false);
  }

  async function toggleVideo() {
    if (!playerRef.current) return;
    if (playerRef.current.paused) await playerRef.current.play();
    else playerRef.current.pause();
  }

  async function handleUploadVideoChange(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setUploadPoster(null);
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) {
      input.value = "";
      setToast("프로토타입에서는 50MB 이하 동영상을 첨부할 수 있어요.");
      return;
    }

    const selectedKey = videoFileKey(file);
    setPosterGenerating(true);
    try {
      const generatedPoster = await captureVideoFirstFrame(file);
      if (input.files?.[0] && videoFileKey(input.files[0]) === selectedKey) {
        setUploadPoster(generatedPoster);
      }
    } catch (error) {
      input.value = "";
      setToast(error.message || "동영상 첫 화면 이미지를 만들지 못했습니다.");
    } finally {
      setPosterGenerating(false);
    }
  }

  function closeUpload() {
    setUploadOpen(false);
    setUploadPoster(null);
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!dbConnected) {
      setToast("Snowflake MOVIEDB 연결 후에만 영상을 등록할 수 있습니다.");
      return;
    }
    if (!categoryOptions.length) {
      setToast("MOVIEDB CATEGORY 값을 불러온 후 등록할 수 있습니다.");
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    const videoFile = formData.get("video");

    if (!(videoFile instanceof File) || !videoFile.size) {
      setToast("동영상 파일을 선택해 주세요.");
      return;
    }

    if (videoFile.size > MAX_VIDEO_BYTES) {
      setToast("프로토타입에서는 50MB 이하 동영상을 첨부할 수 있어요.");
      return;
    }

    setSubmitting(true);

    try {
      const generatedPoster = uploadPoster?.fileKey === videoFileKey(videoFile)
        ? uploadPoster
        : await captureVideoFirstFrame(videoFile);
      const payload = {
        title: String(formData.get("title") || "새로운 뮤직비디오"),
        caption: String(formData.get("caption") || "오늘의 사운드와 장면을 기록했어요."),
        category: String(formData.get("category") || categoryOptions[0]),
        location: String(formData.get("location") || "스튜디오"),
        recordedAt: String(formData.get("recordedAt") || new Date().toISOString().slice(0, 10)),
        durationSeconds: generatedPoster.durationSeconds,
        videoFileName: videoFile.name,
        videoMimeType: videoFile.type || "video/mp4",
        videoDataUrl: await fileToDataUrl(videoFile),
        posterFileName: generatedPoster.fileName,
        posterMimeType: generatedPoster.mimeType,
        posterDataUrl: generatedPoster.dataUrl,
      };
      const response = await fetch(apiUrl("/api/videos"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.message || "데이터베이스에 저장하지 못했어요.");
      setPosts((current) => [mapDatabasePost(saved.video), ...current]);
      setToast("영상과 첫 화면 표지가 Snowflake MOVIEDB에 저장되었습니다.");
      closeUpload();
      form.reset();
    } catch (error) {
      setToast(error.message || "Snowflake MOVIEDB에 영상을 저장하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <a className="studio-brand" href="#studio" aria-label="Musecut 뮤직비디오 스튜디오 홈">
          <strong>Musecut</strong>
          <span>MUSIC VIDEO STUDIO</span>
        </a>
        <div className="studio-project-name">
          <MusicNotes size={16} weight="fill" />
          <span>{featuredPost?.title || "새 뮤직비디오 프로젝트"}</span>
        </div>
        <div className="studio-top-actions">
          <button className={`admin-access-button ${adminSession.authenticated ? "authenticated" : ""}`} type="button" onClick={() => setAdminOpen(true)} aria-label="관리자 메뉴 열기">
            {adminSession.authenticated ? <ShieldCheck size={18} weight="fill" /> : <UserGear size={18} />}
            <span>{adminSession.authenticated ? "관리자 화면" : "관리자"}</span>
          </button>
          <button className="icon-action analysis-action" type="button" onClick={() => setToast("뮤직비디오 분석 리포트는 다음 단계에서 연결할 수 있습니다.")} aria-label="프로젝트 분석">
            <ChartBar size={18} />
          </button>
          <button className="icon-action comment-action" type="button" onClick={() => setToast("프로젝트 코멘트 기능은 준비 중입니다.")} aria-label="프로젝트 코멘트">
            <ChatCircle size={18} />
          </button>
          <span className="project-duration"><Play size={13} weight="fill" />{featuredPost?.duration || "00:00"}</span>
          <button className="share-button" type="button" onClick={() => setToast("공유 링크는 배포 후 생성할 수 있습니다.")}><ShareNetwork size={17} weight="bold" />공유</button>
          <button className="new-video-button" type="button" onClick={() => { setUploadPoster(null); setUploadOpen(true); }} disabled={!dbConnected}><Plus size={17} weight="bold" />새 영상</button>
        </div>
      </header>

      <div className="studio-body" id="studio">
        <nav className="tool-rail" aria-label="뮤직비디오 편집 도구">
          {[
            { id: "media", label: "미디어", icon: SquaresFour },
            { id: "text", label: "텍스트", icon: TextT },
            { id: "audio", label: "오디오", icon: MusicNotes },
            { id: "effects", label: "효과", icon: Shapes },
            { id: "brand", label: "브랜드", icon: ImagesSquare },
            { id: "folder", label: "보관함", icon: FolderOpen },
          ].map(({ id, label, icon: Icon }) => (
            <button key={id} className={activeTool === id ? "active" : ""} type="button" onClick={() => setActiveTool(id)} aria-label={label} title={label}>
              <Icon size={21} weight={activeTool === id ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <aside className="media-library">
          <div className="library-heading">
            <button type="button" aria-label="뒤로" onClick={() => setFilter("전체")}><ArrowLeft size={19} /></button>
            <div><span>MY PROJECT</span><h2>뮤직비디오</h2></div>
          </div>

          {activeTool === "media" ? (
            <>
              <label className="clip-search">
                <MagnifyingGlass size={18} />
                <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="영상 클립 검색" aria-label="영상 클립 검색" />
              </label>
              <div className={`library-db-state ${dbConnected ? "connected" : ""}`}>
                <Database size={14} weight="duotone" />
                <span>{dbChecked && dbConnected ? `MOVIEDB · ${posts.length}개 클립` : dbMessage || "MOVIEDB 연결 중"}</span>
              </div>
              <div className="library-sections">
                {!dbChecked && <div className="library-empty">클립을 불러오는 중입니다.</div>}
                {dbChecked && dbConnected && !libraryGroups.length && <div className="library-empty">등록된 뮤직비디오 클립이 없습니다.</div>}
                {libraryGroups.map((group) => (
                  <section className="library-group" key={group.category}>
                    <header><h3>{group.category}</h3><button type="button" onClick={() => { setFilter(group.category); setActivePost(group.items[0]); }}>모두 보기</button></header>
                    <div className="library-grid">
                      {group.items.map((post) => (
                        <button key={post.id} className={featuredPost?.id === post.id ? "selected" : ""} type="button" onClick={() => openPlayer(post)}>
                          <img src={post.posterUrl} alt={`${post.title} 뮤직비디오 표지`} />
                          <span>{post.duration}</span>
                          <strong>{post.title}</strong>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <div className="tool-placeholder">
              <Waveform size={34} weight="duotone" />
              <h3>{activeTool === "text" ? "가사와 타이틀" : activeTool === "audio" ? "사운드 트랙" : activeTool === "effects" ? "비주얼 효과" : activeTool === "brand" ? "브랜드 키트" : "프로젝트 보관함"}</h3>
              <p>선택한 도구는 다음 편집 단계에서 사용할 수 있습니다. 현재는 등록 영상의 선택과 재생을 지원합니다.</p>
              <button type="button" onClick={() => setActiveTool("media")}>미디어로 돌아가기</button>
            </div>
          )}
        </aside>

        <main className="editor-workspace">
          <header className="workspace-heading">
            <div><span>MUSIC VIDEO / SEQUENCE 01</span><strong>{featuredPost?.title || "새 프로젝트"}</strong></div>
            <div className={`workspace-db ${dbConnected ? "connected" : ""}`}><Database size={14} />{dbConnected ? "Snowflake 동기화" : "연결 대기"}</div>
          </header>

          <section className="stage-area" aria-label="뮤직비디오 미리보기">
            <div className="stage-frame">
              {featuredPost ? (
                <>
                  <video
                    key={`${featuredPost.id}:${featuredPost.assetVersion}`}
                    ref={playerRef}
                    src={featuredPost.videoUrl}
                    poster={featuredPost.posterUrl}
                    playsInline
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                  <div className="stage-copy">
                    <span>NOW PLAYING · {featuredPost.category}</span>
                    <h1>{featuredPost.title}</h1>
                    <p>{featuredPost.caption || "사운드가 장면이 되는 순간"}</p>
                    <small><MapPin size={13} weight="fill" />{featuredPost.location} · {featuredPost.date}</small>
                  </div>
                  <button className={`stage-play ${isPlaying ? "playing" : ""}`} type="button" onClick={toggleVideo} aria-label={isPlaying ? "일시정지" : "뮤직비디오 재생"}>
                    {isPlaying ? <Pause size={28} weight="fill" /> : <Play size={30} weight="fill" />}
                  </button>
                </>
              ) : (
                <div className="empty-stage"><MonitorPlay size={46} weight="duotone" /><h2>첫 뮤직비디오를 시작하세요</h2><p>새 영상을 등록하면 첫 프레임이 무대에 표시됩니다.</p></div>
              )}
            </div>
          </section>

          <section className="timeline-panel" aria-label="영상 타임라인">
            <div className="timeline-toolbar">
              <div><strong>SEQUENCE 01</strong><span>{visiblePosts.length} CLIPS</span></div>
              <button type="button" onClick={() => setFilter("전체")}>전체 클립</button>
            </div>
            <div className="timeline-track">
              <button className="timeline-play" type="button" onClick={toggleVideo} disabled={!featuredPost} aria-label={isPlaying ? "일시정지" : "재생"}>
                {isPlaying ? <Pause size={20} weight="fill" /> : <Play size={22} weight="fill" />}
              </button>
              <div className="timeline-clips" style={{ "--clip-width": `${Math.round(96 + timelineZoom)}px` }}>
                {visiblePosts.map((post) => (
                  <button className={`timeline-clip ${featuredPost?.id === post.id ? "selected" : ""}`} key={post.id} type="button" onClick={() => openPlayer(post)}>
                    <img src={post.posterUrl} alt="" />
                    <span>{post.title}</span>
                    <small>{post.duration}</small>
                  </button>
                ))}
                <button className="timeline-add" type="button" onClick={() => { setUploadPoster(null); setUploadOpen(true); }} disabled={!dbConnected} aria-label="새 뮤직비디오 추가"><Plus size={24} /></button>
              </div>
            </div>
            <div className="timeline-footer">
              <div><FilmSlate size={17} /><span>첫 프레임 자동 표지</span></div>
              <label><span>타임라인 크기</span><input type="range" min="10" max="100" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} /><strong>{timelineZoom}%</strong></label>
            </div>
          </section>
        </main>
      </div>

      {uploadOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeUpload()}>
          <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
            <button className="modal-close dark" type="button" onClick={closeUpload} aria-label="업로드 닫기"><X size={20} /></button>
            <div className="upload-title">
              <span><CloudArrowUp size={22} weight="duotone" /></span>
              <div><p>NEW MUSIC VIDEO</p><h2 id="upload-title">새 뮤직비디오를 등록하세요</h2></div>
            </div>
            <div className={`storage-notice ${dbConnected ? "ready" : ""}`}>
              {dbConnected ? <Check size={16} weight="bold" /> : <Database size={16} />}
              <span>{dbConnected ? "Snowflake · MOVIEDB에 저장된 영상만 화면에 표시됩니다." : "MOVIEDB 연결 후에만 영상을 등록할 수 있습니다."}</span>
            </div>
            <form onSubmit={handleUpload}>
              <div className="field-row">
                <label><span>작품명</span><input name="title" required placeholder="뮤직비디오 제목을 입력하세요" /></label>
                <label><span>촬영 장소</span><input name="location" required placeholder="예: 라이브 스튜디오" /></label>
              </div>
              <div className="field-row">
                <label><span>영상 콘셉트</span><select name="category" defaultValue={categoryOptions[0] || ""} disabled={!categoryOptions.length}>{categoryOptions.map((category) => <option key={category}>{category}</option>)}</select></label>
                <label><span>촬영일</span><input name="recordedAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
              </div>
              <label><span>작품 소개</span><textarea name="caption" rows="3" placeholder="사운드와 장면의 콘셉트를 소개해 주세요" /></label>
              <div className="file-row">
                <label className="file-field"><FilmSlate size={24} weight="duotone" /><span><strong>뮤직비디오 파일</strong><small>MP4, WebM · 최대 50MB</small></span><input name="video" type="file" accept="video/*" onChange={handleUploadVideoChange} required /></label>
                <div className={`auto-poster ${uploadPoster ? "ready" : ""}`} aria-live="polite">
                  {uploadPoster ? <img src={uploadPoster.dataUrl} alt="동영상 첫 화면 자동 표지 미리보기" /> : <FilmSlate size={24} weight="duotone" />}
                  <span><strong>{posterGenerating ? "첫 화면 만드는 중..." : "첫 화면 자동 표지"}</strong><small>{uploadPoster ? `JPG · ${Math.ceil(uploadPoster.sizeBytes / 1024)}KB` : "영상 선택 시 자동으로 생성됩니다."}</small></span>
                </div>
              </div>
              <button className="submit-button" type="submit" disabled={!dbConnected || !categoriesChecked || !categoryOptions.length || posterGenerating || submitting}>{submitting ? "영상과 표지를 저장하는 중..." : "MOVIEDB에 뮤직비디오 등록"}</button>
            </form>
          </section>
        </div>
      )}

      {adminOpen && (
        <AdminModal
          session={adminSession}
          categories={categoryOptions}
          onSessionChange={setAdminSession}
          onClose={() => setAdminOpen(false)}
          refreshPublicVideos={refreshPublicVideos}
          setToast={setToast}
        />
      )}

      {toast && <div className="toast" role="status"><SpeakerHigh size={17} weight="fill" />{toast}</div>}
    </div>
  );
}
