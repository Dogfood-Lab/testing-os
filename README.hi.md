<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# ```hindi
testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**कृत्रिम बुद्धिमत्ता (एआई) के युग में परीक्षण के लिए ऑपरेटिंग सिस्टम**

*एआई-सहायता प्राप्त सॉफ्टवेयर के लिए प्रोटोकॉल, साक्ष्य भंडार और सीखने के चक्र।*

<!-- version:start -->
**v0.2.0-pre** — 7 पैकेज (`@dogfood-lab/*`), पूरे कार्यक्षेत्र के लिए परीक्षण सूट, 'इंजस्ट' रिसीवर सक्रिय, हैंडबुक तैनात।
<!-- version:end -->

📖 **[हैंडबुक पढ़ें →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## यह क्या है

`testing-os` [Dogfood Lab](https://github.com/dogfood-lab) गिटहब संगठन का प्रमुख मोनोरिपो है - जो अब निष्क्रिय कर दिए गए [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) का उत्तराधिकारी है। यह प्रोटोकॉल और बुनियादी ढांचे को एक एआई-आधारित विकास कार्यप्रवाह में परीक्षण चलाने, रिकॉर्ड करने और उनसे सीखने के लिए एक साथ लाता है:

- एक **स्वार्म प्रोटोकॉल** जो कोडबेस के खिलाफ समानांतर एजेंट ऑडिट चलाता है।
- रिकॉर्ड, निष्कर्ष, पैटर्न और सिफारिशों के लिए एक **साक्ष्य भंडार + स्कीमा स्पाइन**।
- एक **नीति + सत्यापनकर्ता** परत जो यह निर्धारित करती है कि "सत्यापित" क्या गिना जाता है - और इसे उपभोक्ता रिपॉजिटरी में लागू करता है।
- एक **इंटेलिजेंस लेयर** जो कच्चे निष्कर्षों को पुन: प्रयोज्य पैटर्न और सिद्धांतों में बदलती है।

## स्थिति

`mcp-tool-shop-org/dogfood-labs` से माइग्रेशन पूरा (2026-04-25)। रिसीवर सक्रिय है: उपभोक्ता रिपॉजिटरी में `dogfood.yml` वर्कफ़्लो इस रिपॉजिटरी पर भेजे जाते हैं, और [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) कमिट से परिणामी रिकॉर्ड और इंडेक्स `main` में वापस जोड़े जाते हैं। हैंडबुक [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) पर तैनात है। v1.0.0 तब जारी किया जाएगा जब [HANDOFF.md](HANDOFF.md) में माइग्रेशन के बाद किए जाने वाले सुधार पूरे हो जाएंगे।

## पैकेज

| पैकेज | स्रोत | उद्देश्य |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 JSON स्कीमा (रिकॉर्ड, निष्कर्ष, पैटर्न, सिफारिश, सिद्धांत, नीति, परिदृश्य, सबमिशन)। |
| `@dogfood-lab/verify` | JS | केंद्रीय सबमिशन सत्यापनकर्ता। सबमिशन यहां से गुजरते हैं इससे पहले कि उन्हें स्थायी रूप से संग्रहीत किया जाए। |
| `@dogfood-lab/findings` | JS | निष्कर्ष अनुबंध + व्युत्पन्न/समीक्षा/संश्लेषण/सलाह देने के पाइपलाइन। |
| `@dogfood-lab/ingest` | JS | पाइपलाइन ग्लू: डिस्पैच → सत्यापित → स्थायी → इंडेक्स। |
| `@dogfood-lab/report` | JS | स्रोत रिपॉजिटरी के लिए सबमिशन बिल्डर। |
| `@dogfood-lab/portfolio` | JS | क्रॉस-रिपॉजिटरी पोर्टफोलियो जनरेटर। |
| `@dogfood-lab/dogfood-swarm` | JS | 10-चरण समानांतर-एजेंट प्रोटोकॉल + SQLite नियंत्रण प्लेन + `swarm` बिन। |

अन्य परीक्षण उपकरण जो **स्वतंत्र रहते हैं** लेकिन प्रकाशित एपीआई के माध्यम से एकीकृत होते हैं: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)।

## लेआउट

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
```

## स्थानीय विकास

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Node ≥ 20 की आवश्यकता है।

## संस्करण

सभी `@dogfood-lab/*` पैकेजों में लॉकस्टेप। वर्तमान में `0.1.0-pre`; पहला स्थिर संस्करण `1.0.0` होगा जब [HANDOFF.md](HANDOFF.md) में माइग्रेशन के बाद किए जाने वाले सुधार पूरे हो जाएंगे। इस README में संस्करण पंक्ति `package.json` से `scripts/sync-version.mjs` के माध्यम से स्वचालित रूप से स्टैंप की जाती है (यह `prebuild` के रूप में चलता है)।

## लाइसेंस

[MIT](LICENSE) © 2026 mcp-tool-shop
```

---

<div align="center">

**[हैंडबुक](https://dogfood-lab.github.io/testing-os/)** · **[सभी रिपॉजिटरी](https://github.com/orgs/dogfood-lab/repositories)** · **[प्रोफ़ाइल](https://github.com/dogfood-lab)**

*पहले उपयोग करें, फिर जारी करें।*

</div>
