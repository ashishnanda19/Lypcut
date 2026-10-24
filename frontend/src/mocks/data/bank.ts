/**
 * Seed script for the mock backend: a founder interview in natural Hinglish.
 *
 * Each word is written `roman|devanagari` with optional flags after the Devanagari:
 *   ~  filler word (um, uh, matlab, basically)
 *   @  English word (so mixed sentences render correctly in both scripts)
 * Sentences are written once here and the mock transcript is built from them.
 */

export interface BankLine {
  speaker: 'S1' | 'S2'
  text: string
  /** Chapter that starts at this line. */
  chapter?: string
  /** A hook-worthy moment that starts at this line. */
  hook?: { title: string; reason: string; score: number; lines: number }
}

export const BANK: BankLine[] = [
  {
    speaker: 'S1',
    chapter: 'Intro',
    text: 'namaste|नमस्ते doston,|दोस्तों, aaj|आज ka|का episode|एपिसोड@ bahut|बहुत khaas|खास hai.|है.',
  },
  {
    speaker: 'S1',
    text: 'aaj|आज hum|हम baat|बात karenge|करेंगे ki|कि funding|फंडिंग@ kaise|कैसे raise|रेज़@ karte|करते hain.|हैं.',
  },
  {
    speaker: 'S1',
    text: 'mere|मेरे saath|साथ hain|हैं Meera,|मीरा, jinhone|जिन्होंने do|दो saal|साल mein|में chaar|चार crore|करोड़ raise|रेज़@ kiye.|किए.',
  },
  {
    speaker: 'S2',
    text: 'thank|थैंक@ you|यू@ Aarav,|आरव, um|अम~@ mujhe|मुझे yahaan|यहाँ aakar|आकर bahut|बहुत achha|अच्छा lag|लग raha|रहा hai.|है.',
  },
  {
    speaker: 'S1',
    chapter: 'Paisa kyun chahiye?',
    text: 'toh|तो basically,|बेसिकली~@ sabse|सबसे pehle|पहले ek|एक sawaal,|सवाल, paisa|पैसा kyun|क्यों chahiye?|चाहिए?',
  },
  {
    speaker: 'S2',
    text: 'dekhiye,|देखिए, funding|फंडिंग@ goal|गोल@ nahi|नहीं hai,|है, funding|फंडिंग@ ek|एक tool|टूल@ hai.|है.',
    hook: {
      title: 'Funding goal nahi, tool hai',
      reason: 'A bold one-line reframe that works on its own as a hook.',
      score: 88,
      lines: 3,
    },
  },
  {
    speaker: 'S2',
    text: 'matlab|मतलब~ agar|अगर aapka|आपका product|प्रोडक्ट@ chal|चल raha|रहा hai,|है, tab|तब hi|ही paisa|पैसा growth|ग्रोथ@ ko|को tez|तेज़ karta|करता hai.|है.',
  },
  { speaker: 'S1', text: 'aur|और aapki|आपकी pehli|पहली galti|गलती kya|क्या thi?|थी?' },
  {
    speaker: 'S2',
    text: 'meri|मेरी sabse|सबसे badi|बड़ी galti|गलती thi|थी ki|कि maine|मैंने chaalis|चालीस lakh|लाख rupaye|रुपये bina|बिना soche|सोचे kharch|खर्च kar|कर diye.|दिए.',
    hook: {
      title: 'The ₹40 lakh mistake',
      reason: 'Opens with a surprising number, then pays it off in two sentences.',
      score: 94,
      lines: 4,
    },
  },
  {
    speaker: 'S2',
    text: 'haan,|हाँ, chaalis|चालीस lakh|लाख ka|का mistake|मिस्टेक@, aur|और wo|वो bhi|भी sirf|सिर्फ ek|एक office|ऑफिस@ ke|के liye.|लिए.',
  },
  {
    speaker: 'S1',
    text: 'oh|ओह~ wow,|वाओ, ye|ये toh|तो kaafi|काफ़ी bada|बड़ा nuksaan|नुकसान tha.|था.',
  },
  {
    speaker: 'S2',
    text: 'bilkul.|बिल्कुल. isliye|इसलिए ab|अब main|मैं har|हर kharche|खर्चे se|से pehle|पहले teen|तीन sawaal|सवाल poochti|पूछती hoon.|हूँ.',
  },
  { speaker: 'S1', text: 'pehla|पहला sawaal|सवाल kaun|कौन sa|सा hai?|है?' },
  {
    speaker: 'S2',
    text: 'kya|क्या isse|इससे revenue|रेवेन्यू@ badhega|बढ़ेगा ya|या cost|कॉस्ट@ ghategi?|घटेगी?',
  },
  {
    speaker: 'S1',
    chapter: 'Investors aur pitch',
    text: 'toh|तो investors|इन्वेस्टर्स@ se|से pehli|पहली baar|बार kaise|कैसे milein?|मिलें?',
  },
  {
    speaker: 'S2',
    text: 'sabse|सबसे asaan|आसान tareeka|तरीका hai|है warm|वॉर्म@ introduction.|इंट्रोडक्शन@.',
  },
  {
    speaker: 'S2',
    text: 'cold|कोल्ड@ email|ईमेल@ bhi|भी kaam|काम karta|करता hai,|है, par|पर usme|उसमें research|रिसर्च@ bahut|बहुत zaroori|ज़रूरी hai.|है.',
  },
  {
    speaker: 'S2',
    text: 'basically,|बेसिकली~@ har|हर investor|इन्वेस्टर@ ek|एक alag|अलग cheez|चीज़ dhoondhta|ढूँढता hai.|है.',
  },
  {
    speaker: 'S1',
    text: 'aur|और pitch|पिच@ deck|डेक@ mein|में kitne|कितने slides|स्लाइड्स@ hone|होने chahiye?|चाहिए?',
  },
  {
    speaker: 'S2',
    text: 'das|दस slides|स्लाइड्स@ se|से zyada|ज़्यादा nahi.|नहीं. problem,|प्रॉब्लम@, solution,|सॉल्यूशन@, traction|ट्रैक्शन@ aur|और ask.|आस्क@.',
    hook: {
      title: '10 slides, bas',
      reason: 'A clear, saveable rule of thumb with a short list viewers will screenshot.',
      score: 81,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'jo|जो baat|बात aap|आप do|दो minute|मिनट mein|में nahi|नहीं samjha|समझा sakte,|सकते, wo|वो investor|इन्वेस्टर@ ko|को bhi|भी samajh|समझ nahi|नहीं aayegi.|आएगी.',
  },
  {
    speaker: 'S1',
    chapter: 'Valuation aur bootstrapping',
    text: 'valuation|वैल्यूएशन@ ke|के baare|बारे mein|में kya|क्या kehna|कहना hai?|है?',
  },
  {
    speaker: 'S2',
    text: 'um|अम~@ dekhiye,|देखिए, valuation|वैल्यूएशन@ ek|एक kahani|कहानी hai,|है, number|नंबर@ nahi.|नहीं.',
    hook: {
      title: 'Valuation ek kahani hai',
      reason: 'Short contrarian claim followed by a consequence, good for a 20 second Reel.',
      score: 77,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'agar|अगर aap|आप bahut|बहुत zyada|ज़्यादा maangoge|माँगोगे toh|तो agle|अगले round|राउंड@ mein|में dikkat|दिक्कत aayegi.|आएगी.',
  },
  { speaker: 'S1', text: 'toh|तो kya|क्या bootstrapping|बूटस्ट्रैपिंग@ behtar|बेहतर hai?|है?' },
  {
    speaker: 'S2',
    text: 'ye|ये aapke|आपके business|बिज़नेस@ par|पर nirbhar|निर्भर karta|करता hai.|है.',
  },
  {
    speaker: 'S2',
    text: 'jahan|जहाँ cash|कैश@ flow|फ़्लो@ jaldi|जल्दी aata|आता hai,|है, wahan|वहाँ bootstrapping|बूटस्ट्रैपिंग@ kamaal|कमाल karti|करती hai.|है.',
  },
  {
    speaker: 'S2',
    text: 'lekin|लेकिन jahan|जहाँ product|प्रोडक्ट@ banane|बनाने mein|में saal|साल lagte|लगते hain,|हैं, wahan|वहाँ funding|फंडिंग@ chahiye.|चाहिए.',
  },
  {
    speaker: 'S1',
    chapter: 'Team aur product-market fit',
    text: 'team|टीम@ ke|के baare|बारे mein|में bataiye.|बताइए.',
  },
  {
    speaker: 'S2',
    text: 'pehle|पहले das|दस logon|लोगों ko|को hire|हायर@ karna|करना sabse|सबसे mushkil|मुश्किल hota|होता hai.|है.',
  },
  {
    speaker: 'S2',
    text: 'matlab|मतलब~ aap|आप culture|कल्चर@ bana|बना rahe|रहे hote|होते ho,|हो, sirf|सिर्फ naukri|नौकरी nahi|नहीं de|दे rahe.|रहे.',
  },
  {
    speaker: 'S2',
    text: 'aur|और ek|एक galat|ग़लत hire|हायर@ poori|पूरी team|टीम@ ko|को thaka|थका sakta|सकता hai.|है.',
  },
  {
    speaker: 'S1',
    text: 'product-market|प्रोडक्ट-मार्केट@ fit|फ़िट@ kaise|कैसे pata|पता chalta|चलता hai?|है?',
  },
  {
    speaker: 'S2',
    text: 'jab|जब log|लोग bina|बिना bole|बोले aapka|आपका product|प्रोडक्ट@ doosron|दूसरों ko|को bataane|बताने lagein.|लगें.',
  },
  {
    speaker: 'S2',
    text: 'basically,|बेसिकली~@ retention|रिटेंशन@ hi|ही sach|सच batata|बताता hai.|है.',
  },
  {
    speaker: 'S2',
    text: 'agar|अगर log|लोग wapas|वापस nahi|नहीं aa|आ rahe,|रहे, toh|तो funding|फंडिंग@ kuch|कुछ nahi|नहीं badlegi.|बदलेगी.',
  },
  {
    speaker: 'S1',
    chapter: 'Sabse mushkil raatein',
    text: 'sabse|सबसे bada|बड़ा darr|डर kya|क्या tha?|था?',
  },
  {
    speaker: 'S2',
    text: 'ki|कि payroll|पेरोल@ nikalna|निकलना mushkil|मुश्किल ho|हो jayega.|जाएगा. wo|वो raatein|रातें main|मैं kabhi|कभी nahi|नहीं bhoolungi.|भूलूँगी.',
    hook: {
      title: 'Payroll wali raatein',
      reason: 'Personal, emotional confession in the first line. Strong retention pattern.',
      score: 91,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'phir|फिर ek|एक investor|इन्वेस्टर@ ne|ने bola,|बोला, hum|हम aap|आप par|पर bharosa|भरोसा karte|करते hain.|हैं.',
  },
  { speaker: 'S1', text: 'wo|वो term|टर्म@ sheet|शीट@ wala|वाला pal|पल kaisa|कैसा tha?|था?' },
  {
    speaker: 'S2',
    text: 'um|अम~@ honestly,|ऑनेस्टली~@ main|मैं ro|रो padi.|पड़ी. lekin|लेकिन pehle|पहले teen|तीन din|दिन kisi|किसी ko|को nahi|नहीं bataya.|बताया.',
    hook: {
      title: 'Term sheet par main ro padi',
      reason: 'A vulnerable moment with a clear arc: reaction, then a twist in the last clause.',
      score: 86,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'kyunki|क्योंकि term|टर्म@ sheet|शीट@ sirf|सिर्फ shuruaat|शुरुआत hai,|है, paisa|पैसा account|अकाउंट@ mein|में aane|आने tak|तक kuch|कुछ pakka|पक्का nahi.|नहीं.',
  },
  {
    speaker: 'S1',
    text: 'legal|लीगल@ side|साइड@ ke|के liye|लिए kya|क्या salah|सलाह dengi?|देंगी?',
  },
  {
    speaker: 'S2',
    text: 'ek|एक achha|अच्छा lawyer|लॉयर@ rakhiye,|रखिए, chahe|चाहे shuru|शुरू mein|में mehenga|महँगा lage.|लगे.',
  },
  {
    speaker: 'S2',
    text: 'aur|और har|हर clause|क्लॉज़@ khud|खुद padhiye,|पढ़िए, matlab|मतलब~ chhoti|छोटी se|से chhoti|छोटी cheez|चीज़ bhi.|भी.',
  },
  {
    speaker: 'S1',
    chapter: 'Brand aur aakhri salah',
    text: 'social|सोशल@ media|मीडिया@ ka|का role|रोल@ kitna|कितना hai?|है?',
  },
  {
    speaker: 'S2',
    text: 'bahut|बहुत bada.|बड़ा. Reels|रील्स@ ne|ने meri|मेरी company|कंपनी@ ko|को teen|तीन guna|गुना visibility|विज़िबिलिटी@ di.|दी.',
    hook: {
      title: 'Reels ne company badli',
      reason: 'Concrete result (3x) up front, then the habit that caused it.',
      score: 73,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'har|हर hafte|हफ़्ते ek|एक short|शॉर्ट@ video|वीडियो@ jo|जो ek|एक hi|ही baat|बात seekhaye.|सिखाए.',
  },
  { speaker: 'S1', text: 'iska|इसका funding|फंडिंग@ se|से kya|क्या lena-dena|लेना-देना hai?|है?' },
  {
    speaker: 'S2',
    text: 'investors|इन्वेस्टर्स@ bhi|भी Instagram|इंस्टाग्राम@ dekhte|देखते hain.|हैं. brand|ब्रांड@ ek|एक tarah|तरह ka|का proof|प्रूफ़@ hai.|है.',
  },
  {
    speaker: 'S1',
    text: 'ek|एक aakhri|आख़िरी sawaal:|सवाल: naye|नए founders|फाउंडर्स@ ko|को kya|क्या salah?|सलाह?',
  },
  {
    speaker: 'S2',
    text: 'jaldi|जल्दी shuru|शुरू kijiye,|कीजिए, jaldi|जल्दी seekhiye,|सीखिए, aur|और galtiyon|गलतियों se|से mat|मत daro.|डरो.',
    hook: {
      title: 'Naye founders ke liye salah',
      reason: 'Quotable closing advice. Slower start, but it ends on a line people repost.',
      score: 69,
      lines: 2,
    },
  },
  {
    speaker: 'S2',
    text: 'uh|उह~@ aur|और haan,|हाँ, sabse|सबसे pehle|पहले apne|अपने customers|कस्टमर्स@ se|से baat|बात kijiye.|कीजिए.',
  },
  { speaker: 'S1', text: 'bahut|बहुत badhiya|बढ़िया Meera.|मीरा. dhanyavaad|धन्यवाद aapka.|आपका.' },
  { speaker: 'S2', text: 'shukriya|शुक्रिया Aarav.|आरव.' },
  {
    speaker: 'S1',
    text: 'toh|तो doston,|दोस्तों, agar|अगर video|वीडियो@ pasand|पसंद aaya|आया ho|हो toh|तो subscribe|सब्सक्राइब@ zaroor|ज़रूर kijiye.|कीजिए.',
  },
]
