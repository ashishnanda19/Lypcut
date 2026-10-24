import { buildTranscript, type BuiltTranscript } from '../../src/transcription/normalize.js'
import type { RawWord } from '../../src/transcription/types.js'

/**
 * A founder interview in natural Hinglish, as speech recognition writes it (Devanagari, English loanwords included).
 * It is built through the real normaliser, so tests run on what the pipeline actually produces. The topics (funding,
 * a costly mistake, a term sheet, a pitch deck, hiring, bootstrapping, payroll fear, reels, valuation) are those of
 * the front end's own sample interview, so the search tests mirror the editor's.
 */
export const LINES: Array<{ speaker: 'host' | 'guest'; text: string }> = [
  { speaker: 'host', text: 'नमस्ते दोस्तों, आज का एपिसोड बहुत खास है।' },
  { speaker: 'host', text: 'आज हम बात करेंगे कि फंडिंग कैसे रेज़ करते हैं।' },
  { speaker: 'host', text: 'मेरे साथ हैं मीरा, जिन्होंने दो साल में चार करोड़ रेज़ किए।' },
  { speaker: 'guest', text: 'थैंक यू आरव, अम मुझे यहाँ आकर बहुत अच्छा लग रहा है।' },
  { speaker: 'host', text: 'तो बेसिकली, सबसे पहले एक सवाल, पैसा क्यों चाहिए?' },
  { speaker: 'guest', text: 'देखिए, फंडिंग गोल नहीं है, फंडिंग एक टूल है।' },
  { speaker: 'guest', text: 'मतलब अगर आपका प्रोडक्ट चल रहा है, तब ही पैसा ग्रोथ को तेज़ करता है।' },
  { speaker: 'host', text: 'और आपकी पहली गलती क्या थी?' },
  {
    speaker: 'guest',
    text: 'मेरी सबसे बड़ी गलती थी कि मैंने चालीस लाख रुपये बिना सोचे खर्च कर दिए।',
  },
  { speaker: 'guest', text: 'टर्म शीट पर साइन करने से पहले लॉयर से क्लॉज़ ज़रूर पढ़वाइए।' },
  { speaker: 'host', text: 'इन्वेस्टर्स को पिच डेक कैसे भेजें?' },
  { speaker: 'guest', text: 'पिच डेक में दस स्लाइड्स रखिए, ट्रैक्शन सबसे ऊपर।' },
  { speaker: 'guest', text: 'हायरिंग का सच यह है कि पहले दस हायर बहुत मायने रखते हैं।' },
  { speaker: 'host', text: 'बूटस्ट्रैपिंग या फंडिंग, आप क्या सलाह देंगे?' },
  { speaker: 'guest', text: 'कैश फ़्लो पॉज़िटिव हो तो बूटस्ट्रैपिंग सबसे अच्छा रास्ता है।' },
  { speaker: 'guest', text: 'पेरोल वाली रात मुझे बहुत डर लगा था।' },
  { speaker: 'host', text: 'रील्स और इंस्टाग्राम से ब्रांड की विज़िबिलिटी कैसे बढ़ाएं?' },
  { speaker: 'guest', text: 'वैल्यूएशन एक कहानी है, नंबर नहीं।' },
]

export interface Fixture {
  transcript: BuiltTranscript
  words: RawWord[]
  /** Length of the recording in seconds. */
  duration: number
}

/** Words 0.4 s each, a pause between lines, speakers alternating as the lines say. */
export function fixtureTranscript(lines = LINES): Fixture {
  const words: RawWord[] = []
  let t = 0.8
  for (const line of lines) {
    t += 0.6
    for (const w of line.text.split(' ')) {
      words.push({ text: w, start: t, end: t + 0.35, speaker: line.speaker })
      t += 0.4
    }
  }
  return {
    transcript: buildTranscript({ words }, { hint: 'hinglish' }),
    words,
    duration: Math.ceil(t + 1),
  }
}
