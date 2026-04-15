# Policy Knowledge Graph Studio

This app is a local policy knowledge-base system with two screens:

- `Admin`: ingest files, folders, local paths, and zip archives into a JSON knowledge graph
- `User`: ask questions against that graph and get grounded answers

## Current behavior

- Builds a local JSON knowledge graph at `data/knowledge-graph.json`
- Supports ingestion of `txt`, `md`, `json`, `csv`, `html`, `xml`, `docx`, and `zip`
- Stores document, section, statement, and keyword nodes with edges between them
- Retrieves relevant graph nodes for a user question
- Uses multiple Sarvam-backed agents for policy analysis, compliance review, and final response writing
- Adds Sarvam speech-to-text for microphone input on the User screen
- Adds Sarvam text-to-speech for reading the final answer aloud

## Run it

```powershell
cd C:\Users\vmadmin\sarvam-multi-agent-app
npm start
```

Then open `http://localhost:3015`.

If `.env` contains a valid `SARVAM_API_KEY`, the query flow will use Sarvam for final answers. Without a key, the app still builds the graph and returns local retrieval summaries.

## Notes

- This version does not implement RAG. It stores and queries a JSON knowledge graph.
- Folder ingestion works from the browser upload control or by entering absolute local paths.
- Zip and docx extraction currently rely on Windows PowerShell archive expansion.
- Voice input uses browser microphone capture and sends audio to Sarvam `speech-to-text`.
- Voice output sends the final answer text to Sarvam `text-to-speech` and plays the returned audio in the browser.
