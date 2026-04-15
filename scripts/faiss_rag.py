import argparse
import hashlib
import json
import re
from pathlib import Path

import faiss
import numpy as np


TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def tokenize(text):
    return [token.lower() for token in TOKEN_RE.findall(text or "") if len(token) > 1]


def build_terms(text):
    tokens = tokenize(text)
    terms = list(tokens)
    for index in range(len(tokens) - 1):
      terms.append(f"{tokens[index]}::{tokens[index + 1]}")
    return terms


def hashed_vector(text, dim):
    vector = np.zeros(dim, dtype="float32")
    terms = build_terms(text)
    if not terms:
        return vector

    for term in terms:
        digest = hashlib.sha256(term.encode("utf-8")).digest()
        weight = 1.35 if "::" in term else 1.0
        for offset in (0, 8, 16):
            idx = int.from_bytes(digest[offset : offset + 4], "little") % dim
            sign = 1.0 if digest[offset + 4] % 2 == 0 else -1.0
            scale = weight * (1.0 + (digest[offset + 5] / 255.0) * 0.25)
            vector[idx] += sign * scale

    norm = np.linalg.norm(vector)
    if norm > 0:
        vector /= norm
    return vector


def load_metadata(metadata_path):
    return json.loads(Path(metadata_path).read_text(encoding="utf-8"))


def build_index(metadata_path, index_path):
    metadata = load_metadata(metadata_path)
    chunks = metadata.get("chunks", [])
    dimension = int(metadata.get("retrieval", {}).get("dimension", 384))

    if not chunks:
        raise SystemExit(json.dumps({"error": "No chunks available to index."}))

    vectors = []
    for chunk in chunks:
        text = f"{chunk.get('documentName', '')}\n{chunk.get('sectionHeading', '')}\n{chunk.get('text', '')}"
        vectors.append(hashed_vector(text, dimension))

    matrix = np.vstack(vectors).astype("float32")
    index = faiss.IndexFlatIP(dimension)
    index.add(matrix)
    faiss.write_index(index, str(index_path))
    print(json.dumps({"ok": True, "chunkCount": len(chunks), "dimension": dimension}))


def search_index(metadata_path, index_path, query, top_k):
    metadata = load_metadata(metadata_path)
    chunks = metadata.get("chunks", [])
    dimension = int(metadata.get("retrieval", {}).get("dimension", 384))
    index = faiss.read_index(str(index_path))

    query_vector = hashed_vector(query, dimension).reshape(1, -1).astype("float32")
    distances, positions = index.search(query_vector, top_k)

    matches = []
    for score, position in zip(distances[0].tolist(), positions[0].tolist()):
        if position < 0 or position >= len(chunks):
            continue
        matches.append(
            {
                "id": chunks[position].get("id"),
                "score": float(score),
                "position": int(position),
            }
        )

    print(json.dumps({"ok": True, "matches": matches}))


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("--metadata", required=True)
    build_parser.add_argument("--index", required=True)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--metadata", required=True)
    search_parser.add_argument("--index", required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--top-k", type=int, default=8)

    args = parser.parse_args()

    if args.command == "build":
        build_index(args.metadata, args.index)
        return

    if args.command == "search":
        search_index(args.metadata, args.index, args.query, args.top_k)
        return


if __name__ == "__main__":
    main()
