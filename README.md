# Policy RAG Studio

This app is a local policy knowledge-base system with two screens:

- `Admin`: ingest files, folders, local paths, and zip archives into a free local RAG index
- `User`: ask questions against that index and get grounded answers

## Current behavior

- Builds a local JSON RAG index at `data/rag-index.json`
- Supports ingestion of `pdf`, `txt`, `md`, `json`, `csv`, `html`, `xml`, `docx`, and `zip`
- Splits documents into chunks and stores per-chunk lexical term statistics
- Retrieves the most relevant chunks for a user question with a free BM25-like retriever
- Uses multiple Sarvam-backed agents for policy analysis, compliance review, and final response writing
- Adds Sarvam speech-to-text for microphone input on the User screen
- Adds Sarvam text-to-speech for reading the final answer aloud

## Run it

```powershell
cd C:\Users\vmadmin\sarvam-multi-agent-app
npm start
```

Then open `http://localhost:3015`.

If `.env` contains a valid `SARVAM_API_KEY`, the query flow will use Sarvam for final answers. Without a key, the app still builds the RAG index and returns local retrieval summaries.

## Notes

- This version uses a free local RAG pipeline, not paid embeddings or a hosted vector database.
- Folder ingestion works from the browser upload control or by entering absolute local paths.
- Zip and docx extraction currently rely on Windows PowerShell archive expansion.
- Voice input uses browser microphone capture and sends audio to Sarvam `speech-to-text`.
- Voice output sends the final answer text to Sarvam `text-to-speech` and plays the returned audio in the browser.
