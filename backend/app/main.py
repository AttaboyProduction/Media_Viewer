import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.app.api.app_control import router as app_control_router
from backend.app.api.media import router as media_router
from backend.app.api.scrape import router as scrape_router
from backend.app.api.tags import router as tags_router
from backend.app.api.tags import tag_groups_router
from backend.app.config import settings
from backend.app.services.hash_backfill import start_hash_backfill
from backend.init_db import init_db

app = FastAPI(title="Scrap Download Viewer")
# Changes on every process start so Reload can wait for a real restart, not the dying server.
BOOT_ID = str(uuid.uuid4())

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(media_router, prefix="/api")
app.include_router(tags_router, prefix="/api")
app.include_router(tag_groups_router, prefix="/api")
app.include_router(scrape_router, prefix="/api")
app.include_router(app_control_router, prefix="/api")

settings.media_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(settings.media_dir)), name="media_files")

assets_dir = settings.frontend_dist / "assets"
if assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend_assets")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    start_hash_backfill()
    # Replace a legacy pythonw Run-key entry with the named Startup shortcut.
    from backend.app.services.app_settings import load_app_settings
    from backend.app.services.windows_startup import sync_launch_on_startup

    sync_launch_on_startup(bool(load_app_settings().get("launch_on_startup")))


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "boot_id": BOOT_ID}


@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    # Do not let the SPA GET catch-all claim /api/* — that yields 405 for missing POST routes.
    if full_path == "api" or full_path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    dist = settings.frontend_dist
    if full_path:
        candidate = dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    return JSONResponse(
        {"detail": "Frontend is not built yet. Use Run.bat to install and build."},
        status_code=404,
    )
