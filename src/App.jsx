import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CloudArrowUp,
  Database,
  FilmSlate,
  MapPin,
  Pause,
  Play,
  Plus,
  SpeakerHigh,
  X,
} from "@phosphor-icons/react";

const assetBase = import.meta.env.BASE_URL || "/";
const sampleVideo = `${assetBase}videos/sample-travel.mp4`;

const seedPosts = [
  {
    id: "ocean-rest",
    category: "쉼",
    title: "바다가 머문 오후",
    location: "강원 고성",
    date: "2026.06.18",
    duration: "00:18",
    caption: "파도 소리만 오래 듣고 싶었던 날의 짧은 기록.",
    posterUrl: `${assetBase}assets/poster-ocean.png`,
    videoUrl: sampleVideo,
    color: "sky",
  },
  {
    id: "city-window",
    category: "도시",
    title: "창문 너머 오래된 골목",
    location: "포르투, 포르투갈",
    date: "2026.05.03",
    duration: "00:24",
    caption: "낯선 도시에서 발견한 가장 따뜻한 빛.",
    posterUrl: `${assetBase}assets/poster-city.png`,
    videoUrl: sampleVideo,
    color: "lavender",
  },
  {
    id: "heritage-note",
    category: "기록",
    title: "천천히 걷는 오래된 길",
    location: "경북 경주",
    date: "2026.04.22",
    duration: "00:21",
    caption: "지도 대신 마음이 가는 쪽으로 걸었던 하루.",
    posterUrl: `${assetBase}assets/poster-heritage.png`,
    videoUrl: sampleVideo,
    color: "sand",
  },
  {
    id: "garden-table",
    category: "맛과 향",
    title: "정원에서 만난 여름의 맛",
    location: "전남 담양",
    date: "2026.07.09",
    duration: "00:16",
    caption: "초록이 가장 짙던 오후, 천천히 나눈 한 상.",
    posterUrl: `${assetBase}assets/poster-taste.png`,
    videoUrl: sampleVideo,
    color: "mint",
  },
  {
    id: "jeju-blue",
    category: "제주",
    title: "파란 말을 따라간 바다",
    location: "제주 구좌",
    date: "2026.07.27",
    duration: "00:20",
    caption: "손바닥만 한 기념품과 함께 기억한 푸른 해변.",
    posterUrl: `${assetBase}assets/poster-jeju.png`,
    videoUrl: sampleVideo,
    color: "blue",
  },
];

const categories = ["쉼", "도시", "기록", "맛과 향", "제주"];

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

function mapDatabasePost(post) {
  return {
    id: post.id,
    category: post.category,
    title: post.title,
    location: post.location,
    date: post.recordedAt ? String(post.recordedAt).slice(0, 10).replaceAll("-", ".") : "오늘",
    duration: formatDuration(Number(post.durationSeconds)),
    caption: post.caption,
    posterUrl: post.hasPoster ? `/api/videos/${post.id}/poster` : `${assetBase}assets/poster-ocean.png`,
    videoUrl: `/api/videos/${post.id}/content`,
    color: "rose",
  };
}

export function App() {
  const [posts, setPosts] = useState(seedPosts);
  const [activePost, setActivePost] = useState(null);
  const [filter, setFilter] = useState("전체");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dbConnected, setDbConnected] = useState(false);
  const [dbChecked, setDbChecked] = useState(false);
  const [toast, setToast] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/videos", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        setDbConnected(Boolean(payload.connected));
        if (payload.configured && Array.isArray(payload.videos) && payload.videos.length) {
          setPosts((current) => [...payload.videos.map(mapDatabasePost), ...current]);
        }
      })
      .catch(() => setDbConnected(false))
      .finally(() => setDbChecked(true));
    return () => controller.abort();
  }, []);

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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const visiblePosts = useMemo(
    () => (filter === "전체" ? posts : posts.filter((post) => post.category === filter)),
    [filter, posts],
  );

  function openPlayer(post) {
    setActivePost(post);
    setIsPlaying(false);
  }

  function closePlayer() {
    playerRef.current?.pause();
    setActivePost(null);
    setIsPlaying(false);
  }

  async function toggleVideo() {
    if (!playerRef.current) return;
    if (playerRef.current.paused) await playerRef.current.play();
    else playerRef.current.pause();
  }

  async function handleUpload(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const videoFile = formData.get("video");
    const posterFile = formData.get("poster");

    if (!(videoFile instanceof File) || !videoFile.size) {
      setToast("동영상 파일을 선택해 주세요.");
      return;
    }

    if (videoFile.size > 50 * 1024 * 1024) {
      setToast("프로토타입에서는 50MB 이하 동영상을 첨부할 수 있어요.");
      return;
    }
    if (posterFile instanceof File && posterFile.size > 1024 * 1024) {
      setToast("표지 이미지는 1MB 이하로 첨부해 주세요.");
      return;
    }

    setSubmitting(true);
    const previewPoster = posterFile instanceof File && posterFile.size
      ? URL.createObjectURL(posterFile)
      : `${assetBase}assets/poster-ocean.png`;
    const localPost = {
      id: `preview-${Date.now()}`,
      title: String(formData.get("title") || "새로운 여행 기록"),
      caption: String(formData.get("caption") || "오늘의 장면을 기록했어요."),
      category: String(formData.get("category") || "기록"),
      location: String(formData.get("location") || "여행지"),
      date: new Date().toISOString().slice(0, 10).replaceAll("-", "."),
      duration: "NEW",
      posterUrl: previewPoster,
      videoUrl: URL.createObjectURL(videoFile),
      color: "rose",
    };

    try {
      const payload = {
        title: localPost.title,
        caption: localPost.caption,
        category: localPost.category,
        location: localPost.location,
        recordedAt: String(formData.get("recordedAt") || new Date().toISOString().slice(0, 10)),
        durationSeconds: 0,
        videoFileName: videoFile.name,
        videoMimeType: videoFile.type || "video/mp4",
        videoDataUrl: await fileToDataUrl(videoFile),
        posterFileName: posterFile instanceof File ? posterFile.name : "",
        posterMimeType: posterFile instanceof File ? posterFile.type : "",
        posterDataUrl: posterFile instanceof File && posterFile.size ? await fileToDataUrl(posterFile) : null,
      };
      const response = await fetch("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.message || "데이터베이스에 저장하지 못했어요.");
      setPosts((current) => [mapDatabasePost(saved.video), ...current]);
      setToast("Snowflake movieDB에 여행 영상이 저장되었습니다.");
    } catch {
      setPosts((current) => [localPost, ...current]);
      setToast("DB 연결 전이라 이 화면에 미리보기로 추가했어요.");
    } finally {
      setSubmitting(false);
      setUploadOpen(false);
      form.reset();
    }
  }

  return (
    <div className="app-shell">
      <div className="coral-rule" />
      <header className="topbar">
        <a className="wordmark" href="#journal" aria-label="하루여행 홈">
          DAYTRIP FILM JOURNAL
        </a>
        <div className={`db-state ${dbConnected ? "connected" : ""}`} title="Snowflake movieDB 연결 상태">
          <Database size={15} weight="duotone" />
          <span>{dbChecked && dbConnected ? "movieDB 연결됨" : "movieDB 연결 대기"}</span>
        </div>
        <button className="upload-button" type="button" onClick={() => setUploadOpen(true)}>
          <Plus size={17} weight="bold" />
          여행 기록하기
        </button>
      </header>

      <main id="journal" className="journal">
        <section className="intro" aria-labelledby="intro-title">
          <img className="bus-mark" src={`${assetBase}assets/travel-bus-source.png`} alt="산호색 캠핑 버스 일러스트" />
          <h1 id="intro-title">일상이 여행이 되다</h1>
          <p>짧게 머문 장면을 오래 기억하는 여행 필름 다이어리</p>
        </section>

        <section className="gallery" aria-labelledby="gallery-title">
          <div className="gallery-heading">
            <div>
              <span>TRAVEL MOMENTS</span>
              <h2 id="gallery-title">오늘, 어디로 떠나볼까요?</h2>
            </div>
            <div className="filters" aria-label="여행 카테고리 필터">
              {["전체", ...categories].map((category) => (
                <button
                  type="button"
                  key={category}
                  className={filter === category ? "active" : ""}
                  onClick={() => setFilter(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="card-row">
            {visiblePosts.map((post, index) => (
              <article className="video-card" key={post.id} style={{ "--delay": `${index * 55}ms` }}>
                <button className="poster-button" type="button" onClick={() => openPlayer(post)} aria-label={`${post.title} 동영상 재생`}>
                  <img src={post.posterUrl} alt={`${post.location} 여행 영상 표지`} />
                  <span className="poster-shade" aria-hidden="true" />
                  <span className="duration">{post.duration}</span>
                  <span className="play-mark" aria-hidden="true"><Play size={22} weight="fill" /></span>
                  <span className="card-location"><MapPin size={13} weight="fill" />{post.location}</span>
                </button>
                <button className="card-copy" type="button" onClick={() => openPlayer(post)}>
                  <span className={`category ${post.color}`}>{post.category}</span>
                  <strong>{post.title}</strong>
                  <span className="view-link">필름 보기 <ArrowRight size={14} /></span>
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="journal-note">
          <span>01 — 05</span>
          <p>평범한 하루도 카메라를 켜는 순간, 한 편의 여행이 됩니다.</p>
          <FilmSlate size={23} weight="duotone" />
        </section>
      </main>

      <footer className="footer">
        <span>DAYTRIP · VIDEO TRAVEL LOG</span>
        <span>당신의 오늘이 오래 머무는 곳</span>
      </footer>

      {activePost && (
        <div className="modal-backdrop player-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closePlayer()}>
          <section className="player-modal" role="dialog" aria-modal="true" aria-labelledby="player-title">
            <button className="modal-close" type="button" onClick={closePlayer} aria-label="동영상 닫기"><X size={20} /></button>
            <div className="video-frame">
              <video
                ref={playerRef}
                src={activePost.videoUrl}
                poster={activePost.posterUrl}
                controls
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
              <button className={`center-play ${isPlaying ? "playing" : ""}`} type="button" onClick={toggleVideo} aria-label={isPlaying ? "일시정지" : "재생"}>
                {isPlaying ? <Pause size={28} weight="fill" /> : <Play size={32} weight="fill" />}
              </button>
            </div>
            <div className="player-copy">
              <div className="player-meta"><span>{activePost.category}</span><span>{activePost.date}</span></div>
              <h2 id="player-title">{activePost.title}</h2>
              <p>{activePost.caption}</p>
              <div className="player-location"><MapPin size={17} weight="fill" /> {activePost.location}</div>
            </div>
          </section>
        </div>
      )}

      {uploadOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setUploadOpen(false)}>
          <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
            <button className="modal-close dark" type="button" onClick={() => setUploadOpen(false)} aria-label="업로드 닫기"><X size={20} /></button>
            <div className="upload-title">
              <span><CloudArrowUp size={22} weight="duotone" /></span>
              <div><p>NEW TRAVEL FILM</p><h2 id="upload-title">오늘의 여행을 남겨보세요</h2></div>
            </div>
            <div className={`storage-notice ${dbConnected ? "ready" : ""}`}>
              {dbConnected ? <Check size={16} weight="bold" /> : <Database size={16} />}
              <span>{dbConnected ? "Snowflake · movieDB에 안전하게 저장됩니다." : "DB 연결 전에는 현재 화면에 미리보기로 추가됩니다."}</span>
            </div>
            <form onSubmit={handleUpload}>
              <div className="field-row">
                <label><span>제목</span><input name="title" required placeholder="여행의 이름을 적어주세요" /></label>
                <label><span>장소</span><input name="location" required placeholder="예: 제주 구좌" /></label>
              </div>
              <div className="field-row">
                <label><span>카테고리</span><select name="category" defaultValue="기록">{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
                <label><span>기록한 날짜</span><input name="recordedAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
              </div>
              <label><span>한 줄 기록</span><textarea name="caption" rows="3" placeholder="그 순간의 공기와 마음을 남겨보세요" /></label>
              <div className="file-row">
                <label className="file-field"><FilmSlate size={24} weight="duotone" /><span><strong>동영상 첨부</strong><small>MP4, WebM · 최대 50MB</small></span><input name="video" type="file" accept="video/*" required /></label>
                <label className="file-field"><CloudArrowUp size={24} weight="duotone" /><span><strong>표지 이미지</strong><small>JPG, PNG · 최대 1MB</small></span><input name="poster" type="file" accept="image/*" /></label>
              </div>
              <button className="submit-button" type="submit" disabled={submitting}>{submitting ? "여행을 저장하는 중..." : "여행 필름 남기기"}</button>
            </form>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><SpeakerHigh size={17} weight="fill" />{toast}</div>}
    </div>
  );
}
