import type { Config } from '../../lib/config.js'
import type { TranscriptionProvider } from '../types.js'
import { AssemblyAiProvider } from './assemblyai.js'
import { OpenAiProvider } from './openai.js'
import { WhisperCppProvider } from './whisper-cpp.js'

type ProviderConfig = Pick<
  Config,
  | 'TRANSCRIPTION_PROVIDER'
  | 'WHISPER_BIN'
  | 'WHISPER_MODEL_PATH'
  | 'WHISPER_THREADS'
  | 'WHISPER_PROMPT'
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'OPENAI_TRANSCRIBE_MODEL'
  | 'ASSEMBLYAI_API_KEY'
  | 'ASSEMBLYAI_BASE_URL'
>

/** Picks the speech recognition engine from TRANSCRIPTION_PROVIDER. Config validation has already checked its key. */
export function createTranscriptionProvider(config: ProviderConfig): TranscriptionProvider {
  switch (config.TRANSCRIPTION_PROVIDER) {
    case 'openai':
      return new OpenAiProvider({
        apiKey: config.OPENAI_API_KEY!,
        baseUrl: config.OPENAI_BASE_URL,
        model: config.OPENAI_TRANSCRIBE_MODEL,
      })
    case 'assemblyai':
      return new AssemblyAiProvider({
        apiKey: config.ASSEMBLYAI_API_KEY!,
        baseUrl: config.ASSEMBLYAI_BASE_URL,
      })
    case 'whisper-local':
      return new WhisperCppProvider({
        bin: config.WHISPER_BIN,
        modelPath: config.WHISPER_MODEL_PATH,
        threads: config.WHISPER_THREADS,
        prompt: config.WHISPER_PROMPT,
      })
  }
}
