import win32com.client
import wave

speaker = win32com.client.Dispatch("SAPI.SpVoice")
stream = win32com.client.Dispatch("SAPI.SpFileStream")
# Setup 16kHz 16-bit Mono (SAPI format code 39: SAFT16kHz16BitMono)
stream.Format.Type = 39 
stream.Open("d:\\Meta\\samples\\voice_response.wav", 3)
speaker.AudioOutputStream = stream
speaker.Speak("Yes, I can hear you clearly. Please confirm our link is verified and operational.")
stream.Close()
