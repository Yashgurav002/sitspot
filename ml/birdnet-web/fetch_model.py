"""Download the official BirdNET V2.4 TF.js models into apps/web/public/birdnet/.

Source: birdnet-team/BirdNET-Analyzer @ v1.5.1 (last tag that ships the TFJS export).
Models are CC BY-NC-SA 4.0 (non-commercial). Usage: python ml/birdnet-web/fetch_model.py
"""
import pathlib
import shutil
import urllib.request
from concurrent.futures import ThreadPoolExecutor

COMMIT = "3f726d606d68ff0c99a7ddc9b0903fe19ad4f7aa"  # tag v1.5.1
BASE = (f"https://raw.githubusercontent.com/birdnet-team/BirdNET-Analyzer/{COMMIT}"
        "/birdnet_analyzer/checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/model/")
OUT = pathlib.Path(__file__).resolve().parents[2] / "apps/web/public/birdnet"

FILES = (["model.json", "labels.json", "mdata/model.json"]
         + [f"group1-shard{i}of13.bin" for i in range(1, 14)]
         + [f"mdata/group1-shard{i}of8.bin" for i in range(1, 9)])



def fetch(name: str) -> None:
    dest = OUT / name
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(BASE + name, tmp)
    tmp.replace(dest)
    print("fetched", name, flush=True)


with ThreadPoolExecutor(12) as pool:  # raw.githubusercontent can be slow per connection
    list(pool.map(fetch, FILES))

# tfjs-backend-wasm binaries (MIT/Apache, from node_modules) so the worker's WASM fallback can load them.
WASM_SRC = OUT.parents[1] / "node_modules/@tensorflow/tfjs-backend-wasm/dist"
for w in WASM_SRC.glob("*.wasm"):
    (OUT / "wasm").mkdir(exist_ok=True)
    shutil.copyfile(w, OUT / "wasm" / w.name)
if not WASM_SRC.exists():
    print("warn: run `pnpm install` first to get tfjs-backend-wasm binaries")

total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file() and p.suffix in (".json", ".bin", ".wasm"))
print(f"done: {OUT} ({total / 1e6:.1f} MB)")
