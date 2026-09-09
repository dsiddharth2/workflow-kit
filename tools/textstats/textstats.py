import json
import sys


def analyze(text):
    words = text.split()
    sentences = [s.strip() for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()]
    unique_words = set(w.lower().strip(".,!?;:'\"") for w in words)

    return json.dumps({
        "ok": True,
        "char_count": len(text),
        "word_count": len(words),
        "sentence_count": len(sentences),
        "unique_words": len(unique_words),
        "avg_word_length": round(sum(len(w) for w in words) / max(len(words), 1), 1),
    })


if __name__ == "__main__":
    text = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read()
    print(analyze(text))
