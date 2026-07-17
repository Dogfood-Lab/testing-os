<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# टेस्टिंग-ओएस

[![सीआई](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![पेजेस](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![डॉगफूड](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![लाइसेंस: एमआईटी](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![नोड](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**एआई युग में परीक्षण के लिए ऑपरेटिंग सिस्टम**

*एआई-सहायक सॉफ़्टवेयर के लिए प्रोटोकॉल, प्रमाण भंडार और शिक्षण लूप।*

<!-- version:start -->
**v1.10.0** — वर्तमान संस्करण। इसमें क्या शामिल किया गया, यह देखने के लिए [CHANGELOG.md](CHANGELOG.md) देखें।
<!-- version:end -->

📖 **[हैंडबुक पढ़ें →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## यह क्या है

`टेस्टिंग-ओएस` आपके रिपॉजिटरी के वास्तविक परीक्षण प्रमाणों को रिकॉर्ड करता है, सत्यापित करता है और एआई-आधारित वर्कफ़्लो में उनसे सीखता है। इसे किसी रिपॉजिटरी पर इंगित करें, और प्रत्येक परीक्षण रन एक ऐसा प्रमाणित रिकॉर्ड बन जाता है जिस पर आप भरोसा कर सकते हैं - यह स्व-रिपोर्ट किया गया पास नहीं है।

आपको क्या मिलता है:

- **प्रमाण-पुष्टि वाले रिकॉर्ड।** प्रत्येक सबमिशन को वास्तविक सीआई रन से जोड़ा जाता है - प्रदाता की अपनी पहचान के माध्यम से, बिना किसी कुंजी के - इससे पहले कि इसे स्वीकार किया जाए। परिणाम एक छेड़छाड़-रोधी, केवल-जोड़ने योग्य प्रमाण भंडार होता है, न कि सम्मान प्रणाली पर आधारित हरा चेक।
- **एक नीति अनुबंध जिसे आप नियंत्रित करते हैं।** YAML में घोषित करें कि "सत्यापित" होने का क्या अर्थ है - एक सीमित, गैर-मूल्यांकन पूर्वानुमान डीएसएल (`फ़ील्ड`/`ऑप`/`वैल्यू` + `ऑल`/`एनी`/`नॉट`/`इम्प्लाइज`) - और इसे अपने रिपॉजिटरी में लागू करें। नीति को शिप करने से पहले `dogfood-verify lint` के साथ जांचें।
- **एक समानांतर-एजेंट स्वार्म प्रोटोकॉल।** कोडबेस के विरुद्ध बहु-एजेंट ऑडिट चलाएं, फिर कच्चे निष्कर्षों को पुन: प्रयोज्य पैटर्न और सिद्धांत में बदलें।
- **एक लाइव स्थिति सतह।** प्रति-रिपॉजिटरी रिकॉर्ड, इंडेक्स और एक स्थिति बैज, ये सभी एक प्रमाण भंडार से परोसे जाते हैं।

यह [डॉगफूड लैब](https://github.com/dogfood-lab) संगठन का प्रमुख मोनोरेपो है - एक `स्वार्म` सीएलआई के पीछे सात `@dogfood-lab/*` पैकेज।

## त्वरित शुरुआत

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

क्या आप चाहते हैं कि आपके स्वयं के रिपॉजिटरी का परीक्षण डेटा यहां दर्ज किया जाए? **[`examples/` स्टार्टर किट](examples/)** आपको पांच मिनट में इसे शुरू करने में मदद करता है (`npx @dogfood-lab/report` सबमिशन बनाता है; `dogfood-init` वर्कफ़्लो को सेट करता है)। ऑपरेटर गाइड, CLI संदर्भ, स्कीमा संदर्भ और एकीकरण के निर्देश **[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** में उपलब्ध हैं। संस्करण-वार विवरण [CHANGELOG.md](CHANGELOG.md) में दिया गया है।

## खतरा मॉडल

टेस्टिंग-ओएस, `repository_dispatch` के माध्यम से विश्वसनीय GitHub रिपॉजिटरी (`mcp-tool-shop-org/*` और `dogfood-lab/*`) से भेजे गए डॉगफूड सबमिशन को संसाधित करता है। सत्यापनकर्ता को सीआई प्रमाण की आवश्यकता होती है - दावा किए गए रन आईडी को प्रदाता के एपीआई के माध्यम से सत्यापित किया जाता है, और गलत आकार वाले, गुम संदर्भों या अमान्य नीति दावों वाले सबमिशन को अस्वीकार कर दिया जाता है।

**उत्पत्ति प्रमाण का आधार है।** `github` सबमिशन के लिए, सत्यापनकर्ता पुष्टि करता है कि दावा किया गया GitHub Actions रन वास्तव में मौजूद है (GitHub API) और यह सबमिशन के `repo` और `commit_sha` को उस सत्यापित रन से जोड़ता है — एक लाइव, बिना कुंजी वाला जांच जो GitHub की अपनी OIDC पहचान पर आधारित है, इसलिए कोई रिकॉर्ड किसी ऐसे रन या कमिट की पुष्टि नहीं कर सकता जो वास्तव में हुआ ही नहीं। **GitLab CI** का समर्थन वैकल्पिक रूप से किया जाता है (`source.provider: gitlab`); GitLab सबमिशन एकमात्र ऐसा मामला है जहां सत्यापनकर्ता एक गैर-GitHub होस्ट (`gitlab.com/api`) को कॉल करता है, और केवल `gitlab` सबमिशन के लिए।

**रिकॉर्ड की अखंडता छेड़छाड़-विरोधी है, छेड़छाड़-प्रूफ नहीं।** प्रत्येक संग्रहीत रिकॉर्ड में एक `integrity` ब्लॉक होता है (`submission_digest` + `prev_digest`) जो एक अपेंड-ओनली हैश श्रृंखला बनाता है जिसे `dogfood ingest --verify-chain` पूरी तरह से ऑफ़लाइन सत्यापित करता है — यह बाहरी छेड़छाड़, डिस्क भ्रष्टाचार और आंशिक पुनर्स्थापना का पता लगाता है। यह स्वयं इनजेस्ट क्रेडेंशियल के खिलाफ सुरक्षा नहीं करता है, जो एक रिकॉर्ड और श्रृंखला दोनों को फिर से लिख सकता है; इसके लिए लेखक के नियंत्रण से बाहर एक एंकर की आवश्यकता होती है। एक **वैकल्पिक, डिफ़ॉल्ट रूप से बंद XRPL एंकर** (`dogfood ingest --anchor-*`) श्रृंखला के शीर्ष को सार्वजनिक XRP लेज़र पर दर्ज करता है, जिससे एंकर किए गए बिंदु से नीचे किसी भी प्रकार की छेड़छाड़ या पुनर्लेखन का पता लगाया जा सकता है — यह दूसरा प्रकटीकृत गैर-GitHub कॉल है, और केवल तभी जब ऑपरेटर इसे सक्षम करे।

**परीक्षण-ओएस किन चीज़ों को प्रभावित करता है:** प्रत्येक `repository_dispatch` पेलोड में सबमिट की गई JSON; इस रिपॉजिटरी में `policies/`, `fixtures/`, `records/`, `indexes/`, और `dogfood/roadmap/`; (अंतिम केवल ऑपरेटर द्वारा शुरू किए गए `swarm roadmap compile` से लिखा जाता है — कभी भी स्वचालित इनजेस्ट पाथ द्वारा नहीं); उत्पत्ति सत्यापन के लिए `api.github.com` पर आउटबाउंड कॉल; और — केवल `github` सबमिशन के लिए — सबमिट की गई रिपॉजिटरी के `dogfood/scenarios/<scenario_id>.yaml` का रीड-ओनली फ़ेच, जो प्रमाणित कमिट पर होता है (वह परिदृश्य परिभाषा जो आवश्यक चरणों को लागू करती है; उपयोग से पहले आकार-सीमित और स्कीमा-मान्य, अनुपस्थित फाइलें केवल उस जांच को बिना किसी दृश्यमान चेतावनी के अप्रभावी छोड़ देती हैं)।

**टेस्टिंग-ओएस क्या नहीं छूता:** घोषित `dogfood/scenarios/` परिभाषा फ़ाइलों से परे उपभोक्ता स्रोत कोड, उपभोक्ता रिपॉजिटरी में प्रेषण लिफाफे से परे गुप्त जानकारी, या इस रिपॉजिटरी की कार्यशील ट्री के बाहर कुछ भी।

**परिणाम-अवस्था परिवर्तन प्रमाण प्रदान करते हैं और केवल जोड़े जा सकते हैं।** स्वार्म नियंत्रण प्लेन की समापन क्रियाएँ (`swarm reopen`, `swarm close`) एक स्पष्ट कारण, प्रमाण और — ऑपरेटर द्वारा किए गए समापन के लिए — घोषित सत्यापन मोड की आवश्यकता होती है; प्रत्येक परिवर्तन एक अपरिवर्तनीय `finding_events` पंक्ति लिखता है जो कार्य करने वाले प्राधिकरण को रिकॉर्ड करता है। कोई भी स्वचालित पाथ पुरानी जानकारी के आधार पर किसी परिणाम को बंद नहीं कर सकता या भविष्यवाणी के आधार पर उसे फिर से खोल नहीं सकता, और कोई भी क्रिया घटना इतिहास को दोबारा नहीं लिख सकती — गलत तरीके से उपयोग किए गए क्रेडेंशियल परिवर्तनों को जोड़ सकते हैं, लेकिन प्रत्येक अतिरिक्त स्वयं रिकॉर्ड में होता है।

**नेटवर्क सतह।** डिफ़ॉल्ट रूप से, एकमात्र आउटगोइंग कनेक्शन `api.github.com` (केवल पढ़ने के लिए उत्पत्ति) है। दो अपवाद वैकल्पिक हैं और ऊपर बताए गए हैं: एक GitLab-प्रदाता सबमिशन (`gitlab.com/api`), और ऑपरेटर द्वारा सक्षम XRPL एंकर रन। **कोई टेलीमेट्री नहीं, कोई एनालिटिक्स नहीं — यह कोडबेस कभी भी स्वचालित रूप से डेटा नहीं भेजता; उन दो वैकल्पिक रास्तों के अभाव में, यह GitHub से परे किसी भी नेटवर्क सतह को उजागर नहीं करता है।** रिसीवर वर्कफ़्लो केवल इस रिपॉजिटरी तक सीमित `contents: write` स्कोप के साथ चलता है।

## पैकेज

| पैकेज | स्रोत | उद्देश्य |
|---------|--------|---------|
| `@dogfood-lab/schemas` | टाइपस्क्रिप्ट | 8 JSON स्कीमा (रिकॉर्ड, निष्कर्ष, पैटर्न, अनुशंसा, सिद्धांत, नीति, परिदृश्य, सबमिशन)। |
| `@dogfood-lab/verify` | JS | केंद्रीय सबमिशन सत्यापनकर्ता। सबमिशन यहां से गुजरते हैं इससे पहले कि उन्हें स्थायी रूप से संग्रहीत किया जाए। |
| `@dogfood-lab/findings` | JS | निष्कर्ष अनुबंध + व्युत्पन्न/समीक्षा/संश्लेषण/सलाह पाइपलाइन। |
| `@dogfood-lab/ingest` | JS | पाइपलाइन ग्लू: प्रेषण → सत्यापित करें → बनाए रखें → अनुक्रमित करें। |
| `@dogfood-lab/report` | JS | स्रोत रिपॉजिटरी के लिए सबमिशन बिल्डर। |
| `@dogfood-lab/portfolio` | JS | क्रॉस-रिपॉजिटरी पोर्टफोलियो जनरेटर। |
| `@dogfood-lab/dogfood-swarm` | JS | 10-चरण समानांतर-एजेंट प्रोटोकॉल + SQLite नियंत्रण विमान + `स्वार्म` बिन। |

भाई परीक्षण उपकरण जो **स्वतंत्र रहते हैं** लेकिन प्रकाशित एपीआई के माध्यम से एकीकृत होते हैं: [`शिपचेक`](https://github.com/mcp-tool-shop-org/shipcheck), [`रिपो-नॉलेज`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`एआई-आइज-एमसीपी`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`टेस्ट-इंजन`](https://github.com/mcp-tool-shop-org/taste-engine), [`स्टाइल-डेटासेट-लैब`](https://github.com/mcp-tool-shop-org/style-dataset-lab)।

## लेआउट

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json, trends.json, badges/ (shields.io endpoints)
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml, self-dogfood.yml
```

## स्थानीय विकास

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

नोड ≥ 22 की आवश्यकता है। सीआई मैट्रिक्स `उबंटू-नवीनतम` पर नोड 22 + 24 चलाता है; स्थानीय रूप से नोड 25 पर मान्य किया गया।

**समर्थित फ़ाइल सिस्टम:** एपीएफएस, एचएफएस+, एक्सटी4 (सीआई आधार रेखा), एनटीएफएस - कोई भी जो पीओएसआईएक्स `लिंक(2)` को लागू करता है। **समर्थित नहीं:** ईएक्सएफएटी, एफएटी32। [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) में फ़ाइल-लॉक सीएएस को परमाणु प्रकाशन के लिए हार्डलिंक सिमेंटिक्स की आवश्यकता होती है; ईएक्सएफएटी पर, `linkSync` `ENOTSUP` (जोरदार, मौन नहीं) देता है। सामान्य समस्या: क्रॉस-प्लेटफ़ॉर्म बाहरी एसएसडी अक्सर ईएक्सएफएटी में स्वरूपित होते हैं - इसके बजाय स्थानीय एपीएफएस/एचएफएस+ में रिपॉजिटरी को क्लोन करें। पूर्ण सत्र जी सत्यापन मैट्रिक्स के लिए [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) देखें।

## संस्करण नियंत्रण

सभी `@dogfood-lab/*` पैकेज एक साथ अपडेट होते हैं — मोनोरिपो में एक ही संख्या। छह पैकेज v1.10.0 पर लॉकस्टेप में npm पर `@dogfood-lab` के तहत प्रकाशित होते हैं (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); सातवां, `@dogfood-lab/portfolio`, आंतरिक बना रहता है। इस रीडमी के शीर्ष के पास संस्करण पंक्ति को प्रत्येक `npm run build` पर [`scripts/sync-version.mjs`](scripts/sync-version.mjs) के माध्यम से `package.json` से स्वचालित रूप से जोड़ा जाता है।

## लाइसेंस

[एमआईटी](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** · **[सभी रिपॉजिटरीज़](https://github.com/orgs/dogfood-lab/repositories)** · **[प्रोफ़ाइल](https://github.com/dogfood-lab)**

पहले खाओ, फिर काम करो।

</div>
