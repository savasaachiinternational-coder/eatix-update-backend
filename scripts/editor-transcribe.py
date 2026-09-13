"""Self-hosted speech recognition. No user media is sent to a third party.
Provision faster-whisper and a local model before setting EDITOR_WHISPER_MODEL.
"""
import json
import os
import sys
from faster_whisper import WhisperModel

model = WhisperModel(os.environ['EDITOR_WHISPER_MODEL'], device='cpu', compute_type='int8', local_files_only=True)
segments, info = model.transcribe(sys.argv[1], language=sys.argv[2], vad_filter=True, word_timestamps=True)
cues = []
for segment in segments:
    words = segment.words or []
    if not words:
        cues.append({'text': segment.text.strip(), 'startSec': segment.start, 'endSec': segment.end})
        continue
    chunk = []
    for word in words:
        chunk.append(word)
        text = ''.join(w.word for w in chunk).strip()
        if len(text) >= 38 or word.end - chunk[0].start >= 3.5:
            cues.append({'text': text, 'startSec': chunk[0].start, 'endSec': word.end})
            chunk = []
    if chunk:
        cues.append({'text': ''.join(w.word for w in chunk).strip(), 'startSec': chunk[0].start, 'endSec': chunk[-1].end})
print(json.dumps({'cues': cues}, ensure_ascii=False))
