# Builds ~/voice-fakemic.wav (1 s silence + whisper.cpp's JFK sample + 3 s silence)
# for Chromium's --use-file-for-fake-audio-capture. It lives in $HOME because
# snap Chromium can't read the host /tmp.
import os, wave
here = os.path.dirname(os.path.abspath(__file__))
w = wave.open(os.path.join(here, "../whisper.cpp/samples/jfk.wav"))
f = w.readframes(w.getnframes())
o = wave.open(os.path.expanduser("~/voice-fakemic.wav"), "wb")
o.setparams(w.getparams()); o.writeframes(b"\0" * 32000 + f + b"\0" * 96000); o.close()
print(os.path.expanduser("~/voice-fakemic.wav"))
