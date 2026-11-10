param([string]$TextFile, [string]$OutFile, [int]$Rate = 1)
# Genera un WAV con la voz en español de Windows (Microsoft Helena) a partir de un archivo de texto UTF-8.
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
if ($voice) { $s.SelectVoice($voice.VoiceInfo.Name) }
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$s.Speak((Get-Content -Raw -Encoding UTF8 $TextFile))
$s.Dispose()
