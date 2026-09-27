(function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════
     CREATIVOS ENGINE — Motor de generación Apple-style para GO APPLE
     Generación de imágenes con IA: desactivada (diseño manual).
     ══════════════════════════════════════════════════════════════ */

  var IMAGE_GENERATION_ENABLED = false;
  window.CREATIVOS_IMAGE_GENERATION_ENABLED = IMAGE_GENERATION_ENABLED;

  const ANALYSIS_DEFAULTS = {
    post_type: "product",
    slide_count: 1,
    product_detected: "iPhone",
    product_color: "",
    dominant_bg: "black",
    has_price: false,
    visual_style: "minimal",
    existing_copy: [],
    copy_tone: "premium",
  };

  /* ── Helpers ─────────────────────────────────────────────────── */

  function truncateForImage(text, maxWords = 6) {
    const words = (text || "").trim().split(/\s+/);
    if (words.length <= maxWords) return text.trim();
    return words.slice(0, maxWords).join(" ") + ".";
  }

  function stripEmojis(str) {
    return (str || "")
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
        ""
      )
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function parseJSON(raw) {
    let clean = raw.trim();
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(clean);
  }

  async function fetchWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     FASE 1 — Analizar referencia con GPT Vision
     ══════════════════════════════════════════════════════════════ */

  async function analyzeReference(imageDataUris, openaiKey) {
    console.log("[CreativosEngine][FASE_1] Analizando referencia…");

    try {
      const resp = await fetch("/api/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + openaiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                'Analyze this Instagram post image and return ONLY a valid JSON object. No explanation, no markdown, no backticks. Just raw JSON.\n\nFields:\n- "post_type": one of "product" | "promo" | "carousel_info" | "branding"\n- "slide_count": number\n- "product_detected": string (exact product, e.g. "iPhone 16 Pro")\n- "product_color": string (e.g. "Black Titanium", "" if unclear)\n- "dominant_bg": "black" | "white" | "gray"\n- "has_price": boolean\n- "visual_style": "minimal" | "bold" | "typographic"\n- "existing_copy": array of strings (text visible in images)\n- "copy_tone": "premium" | "urgency" | "informative"\n\nCLASSIFICATION RULES for post_type — follow these strictly:\n- "promo": The post shows a PRODUCT with a PRICE, offer, discount, payment plan, or "available now". Any mention of money ($), installments (cuotas), or payment methods = promo.\n- "product": The post shows a PRODUCT (iPhone, AirPods, etc.) WITHOUT any price. Just showcasing the device, features, or specs.\n- "carousel_info": Multiple slides with tips, comparisons, how-to, educational content, lists, or storytelling about tech. NOT selling a specific product.\n- "branding": Memes, engagement posts, POV posts, motivational content, brand identity. Text-heavy, no specific product being sold.\n\nIf multiple images are provided, count them for slide_count. If they show a product with price info across slides, it is "promo" not "carousel_info".',
            },
            {
              role: "user",
              content: (() => {
                const uris = Array.isArray(imageDataUris) ? imageDataUris : [imageDataUris];
                const totalImages = uris.length;
                const items = [
                  { type: "text", text: "Analyze this Instagram post. It has " + totalImages + " image(s). If there are multiple images, this is a carousel post." }
                ];
                const indicesToSend = totalImages <= 4
                  ? uris.map((_, i) => i)
                  : [0, 1, totalImages - 2, totalImages - 1];

                indicesToSend.forEach(i => {
                  if (uris[i]) {
                    items.push({
                      type: "image_url",
                      image_url: { url: uris[i], detail: "low" }
                    });
                  }
                });
                return items;
              })(),
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
        }),
      });

      if (!resp.ok) throw new Error("Vision API " + resp.status);

      const data = await resp.json();
      const raw = (data.choices?.[0]?.message?.content || "").trim();
      console.log("[CreativosEngine][FASE_1] Raw response:", raw);

      const parsed = parseJSON(raw);

      const analysis = { ...ANALYSIS_DEFAULTS };
      if (["product", "promo", "carousel_info", "branding"].includes(parsed.post_type))
        analysis.post_type = parsed.post_type;
      if (typeof parsed.slide_count === "number" && parsed.slide_count >= 1)
        analysis.slide_count = Math.min(parsed.slide_count, 10);
      if (parsed.product_detected)
        analysis.product_detected = String(parsed.product_detected).slice(0, 60);
      if (parsed.product_color)
        analysis.product_color = String(parsed.product_color).slice(0, 30);
      if (["black", "white", "gray"].includes(parsed.dominant_bg))
        analysis.dominant_bg = parsed.dominant_bg;
      if (typeof parsed.has_price === "boolean") analysis.has_price = parsed.has_price;
      if (["minimal", "bold", "typographic"].includes(parsed.visual_style))
        analysis.visual_style = parsed.visual_style;
      if (Array.isArray(parsed.existing_copy))
        analysis.existing_copy = parsed.existing_copy.map((s) => String(s).slice(0, 200));
      if (["premium", "urgency", "informative"].includes(parsed.copy_tone))
        analysis.copy_tone = parsed.copy_tone;

      console.log("[CreativosEngine][FASE_1] Análisis:", analysis);
      return analysis;
    } catch (e) {
      console.error("[CreativosEngine][FASE_1] Error, usando defaults:", e.message);
      return { ...ANALYSIS_DEFAULTS };
    }
  }

  /* ══════════════════════════════════════════════════════════════
     FASE 2 — Generar copy adaptado
     ══════════════════════════════════════════════════════════════ */

  const COPY_SYSTEM_PROMPTS = {
    product:
      "Sos el copywriter de GO APPLE, tienda premium de iPhones en Argentina. Escribí un headline de 4-5 palabras en español Argentina estilo Apple. Solo el nombre del producto y una cualidad. Sin emojis. Sin signos de exclamación. Subtext máximo 8 palabras, complementario al headline. Respondé SOLO con JSON válido.",
    promo:
      "Sos el copywriter de GO APPLE, tienda premium de iPhones en Argentina. Para la slide de producto: headline con nombre + capacidad (ej: 'iPhone 16 Pro. 256GB.'). Para la slide de precio: headline con precio y forma de pago en máximo 4 palabras (ej: '$800.000 efectivo'). Subtext con la otra forma de pago o cuotas. Sin emojis. Respondé SOLO con JSON válido.",
    carousel_info:
      "Sos el copywriter de GO APPLE, tienda premium de iPhones en Argentina. Replicá la estructura del carrusel original adaptada a GO APPLE. Mismo número de slides que la referencia. Frases cortas, impacto directo. Español Argentina, voseo. Headline máximo 5 palabras, subtext máximo 8 palabras por slide. Sin emojis. Respondé SOLO con JSON válido.",
    branding:
      "Sos el copywriter de GO APPLE, tienda premium de iPhones en Argentina. Escribí un mensaje institucional breve para GO APPLE. Headline máximo 5 palabras. Premium, confianza, cercano. Español Argentina. Sin emojis. Respondé SOLO con JSON válido.",
  };

  async function generateCopy(analysis, referenceText, openaiKey) {
    console.log("[CreativosEngine][FASE_2] Generando copy para:", analysis.post_type);

    const systemPrompt = COPY_SYSTEM_PROMPTS[analysis.post_type] || COPY_SYSTEM_PROMPTS.product;

    const slideCount =
      analysis.post_type === "promo" ? 2 : analysis.slide_count || 1;

    const userPrompt = `Producto detectado: ${analysis.product_detected}${analysis.product_color ? " (" + analysis.product_color + ")" : ""}
Tipo de post: ${analysis.post_type}
Tiene precio: ${analysis.has_price ? "sí" : "no"}
Tono: ${analysis.copy_tone}
Copy original de referencia: "${stripEmojis(referenceText || "").slice(0, 400)}"
Cantidad de slides: ${slideCount}

Respondé con este JSON exacto:
{
  "slides": [
    {
      "slide_index": 0,
      "headline": "...",
      "subtext": "...",
      "brand_line": "GO APPLE",
      "slide_type": "hero"
    }
  ]
}

slide_type puede ser: "hero" (producto principal), "price" (precio/pago), "feature" (característica), "cta" (llamado a acción).
Para promo: slide 0 = "hero", slide 1 = "price".
Generá exactamente ${slideCount} slides.`;

    try {
      const resp = await fetch("/api/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + openaiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 500,
          temperature: 0.4,
        }),
      });

      if (!resp.ok) throw new Error("Copy API " + resp.status);

      const data = await resp.json();
      const raw = (data.choices?.[0]?.message?.content || "").trim();
      console.log("[CreativosEngine][FASE_2] Raw copy:", raw);

      const parsed = parseJSON(raw);

      if (!parsed.slides || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
        throw new Error("No slides in response");
      }

      parsed.slides = parsed.slides.map((s, i) => ({
        slide_index: i,
        headline: truncateForImage(stripEmojis(s.headline || ""), 6),
        subtext: truncateForImage(stripEmojis(s.subtext || ""), 10),
        brand_line: s.brand_line || "GO APPLE",
        slide_type: s.slide_type || "hero",
      }));

      console.log("[CreativosEngine][FASE_2] Copy final:", parsed.slides);
      return parsed;
    } catch (e) {
      console.error("[CreativosEngine][FASE_2] Error, usando copy fallback:", e.message);
      const fallbackHeadline = truncateForImage(
        stripEmojis(referenceText || analysis.product_detected || "GO APPLE"),
        5
      );
      return {
        slides: [
          {
            slide_index: 0,
            headline: fallbackHeadline,
            subtext: "",
            brand_line: "GO APPLE",
            slide_type: "hero",
          },
        ],
      };
    }
  }

  /* ══════════════════════════════════════════════════════════════
     FASE 2b — Extraer headlines del copy existente
     ══════════════════════════════════════════════════════════════ */

  function parseCopyStructure(rawCopy) {
    var clean = stripEmojis(rawCopy).trim();
    var lines = clean.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);

    var result = {
      hook: "",
      product: "",
      storage: "",
      battery: "",
      bonus: "",
      priceEfectivo: "",
      priceTransfer: "",
      cuotas: "",
      cta: "",
    };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (/\$[\d.,]+/.test(line) && /efectivo/i.test(line)) {
        result.priceEfectivo = line.match(/\$[\d.,]+/)[0];
      } else if (/\$[\d.,]+/.test(line) && /transfer/i.test(line)) {
        result.priceTransfer = line.match(/\$[\d.,]+/)[0];
      } else if (/\$[\d.,]+/.test(line) && !result.priceEfectivo) {
        result.priceEfectivo = line.match(/\$[\d.,]+/)[0];
      }

      if (/cuotas?/i.test(line)) {
        var cuotasMatch = line.match(/(\d+)\s*cuotas?/i);
        result.cuotas = cuotasMatch ? cuotasMatch[0] : line;
      }

      if (/iphone|ipad|macbook|mac|airpods|apple\s*watch/i.test(line) && !result.product) {
        var prodMatch = line.match(/(iphone|ipad|macbook|mac\b|airpods|apple\s*watch)\s*\d*\s*(pro\s*(max)?|plus|mini|air|ultra|se)?/i);
        if (prodMatch) result.product = prodMatch[0].trim();
      }

      if (/\d+\s*gb/i.test(line) && !result.storage) {
        var storageMatch = line.match(/\d+\s*gb/i);
        if (storageMatch) result.storage = storageMatch[0];
      }

      if (/bater[ií]a\s*\d+/i.test(line)) {
        var batMatch = line.match(/bater[ií]a\s*\d+\s*%?/i);
        if (batMatch) result.battery = batMatch[0];
      }

      if (/regalo|gratis|bonus|llev[aá]te/i.test(line) && !result.bonus) {
        result.bonus = line.replace(/^[-–—•*]\s*/, "");
      }

      if (/escribi|consult|contact/i.test(line) && !result.cta) {
        result.cta = line;
      }
    }

    if (!result.hook && lines.length > 0) {
      for (var j = 0; j < lines.length; j++) {
        if (!/^\$|^#|cuotas|efectivo|transfer|bater|regalo|escribi/i.test(lines[j])) {
          result.hook = lines[j];
          break;
        }
      }
    }

    if (!result.product) {
      result.product = analysis && analysis.product_detected ? analysis.product_detected : "iPhone";
    }

    return result;
  }

  async function extractSlidesFromCopy(existingCopy, analysis) {
    console.log("[CreativosEngine][FASE_2b] Parseando copy para extraer datos reales…");

    var copyLines = existingCopy.split(/\n+/).filter(function (l) { return l.trim(); });
    var hasSlideLabels = copyLines.some(function (l) { return /^slide\s*\d+\s*:/i.test(l.trim()); });

    var slides = [];

    if (hasSlideLabels) {
      console.log("[CreativosEngine][FASE_2b] Copy con formato 'Slide N:' detectado");
      var currentText = "";
      var slideTexts = [];
      for (var i = 0; i < copyLines.length; i++) {
        var cl = copyLines[i].trim();
        if (/^slide\s*\d+\s*:/i.test(cl)) {
          if (currentText) slideTexts.push(currentText.trim());
          currentText = cl.replace(/^slide\s*\d+\s*:\s*/i, "");
        } else {
          currentText += (currentText ? " " : "") + cl;
        }
      }
      if (currentText) slideTexts.push(currentText.trim());

      for (var k = 0; k < slideTexts.length; k++) {
        var clean = stripEmojis(slideTexts[k]).trim();
        var words = clean.split(/\s+/).filter(Boolean);
        var headline = words.slice(0, 6).join(" ");
        var subtext = words.length > 6 ? truncateForImage(words.slice(6).join(" "), 8) : "";

        var slideType = "content";
        if (k === 0) slideType = "hero";
        if (/\$[\d.,]+/.test(slideTexts[k])) slideType = "price";

        slides.push({
          slide_index: k,
          headline: headline,
          subtext: subtext,
          brand_line: "GO APPLE",
          slide_type: slideType,
        });
      }

      if (analysis) analysis.post_type = slides.length > 1 ? "carousel_info" : "product";

    } else {
      var parsed = parseCopyStructure(existingCopy);
      console.log("[CreativosEngine][FASE_2b] Parsed estructura:", JSON.stringify(parsed));

      var hasPrice = !!(parsed.priceEfectivo || parsed.priceTransfer);

      if (hasPrice) {
        var heroHeadline = parsed.product || "iPhone";
        if (parsed.storage) heroHeadline += " " + parsed.storage;
        var heroSub = parsed.battery || parsed.hook || "";

        slides.push({
          slide_index: 0,
          headline: truncateForImage(heroHeadline, 4),
          subtext: truncateForImage(heroSub, 6),
          brand_line: "GO APPLE",
          slide_type: "hero",
        });

        var priceHeadline = parsed.priceEfectivo || parsed.priceTransfer || "";
        var priceSub = "";
        if (parsed.cuotas) priceSub = parsed.cuotas;
        if (parsed.priceTransfer && parsed.priceEfectivo) {
          priceSub = parsed.priceTransfer + " transferencia";
          if (parsed.cuotas) priceSub += " | " + parsed.cuotas;
        }

        slides.push({
          slide_index: 1,
          headline: priceHeadline,
          subtext: truncateForImage(priceSub, 8),
          brand_line: "GO APPLE",
          slide_type: "price",
        });

        if (analysis) analysis.post_type = "promo";

      } else {
        var allClean = copyLines.map(function (l) { return stripEmojis(l.trim()); }).filter(Boolean);

        if (allClean.length > 1) {
          for (var m = 0; m < allClean.length && m < 8; m++) {
            slides.push({
              slide_index: m,
              headline: truncateForImage(allClean[m], 6),
              subtext: "",
              brand_line: "GO APPLE",
              slide_type: m === 0 ? "hero" : "content",
            });
          }
          if (analysis && slides.length > 1) analysis.post_type = "carousel_info";
        } else {
          var productLine = parsed.product || "iPhone";
          var hookLine = parsed.hook || allClean[0] || "";
          slides.push({
            slide_index: 0,
            headline: truncateForImage(productLine, 4),
            subtext: truncateForImage(hookLine, 8),
            brand_line: "GO APPLE",
            slide_type: "hero",
          });
        }
      }
    }

    if (slides.length === 0) {
      slides.push({
        slide_index: 0,
        headline: "iPhone",
        subtext: "",
        brand_line: "GO APPLE",
        slide_type: "hero",
      });
    }

    console.log("[CreativosEngine][FASE_2b] Slides armados (" + slides.length + "):", slides.map(function (s) {
      return "S" + (s.slide_index + 1) + " [" + s.slide_type + "] " + s.headline + " | " + s.subtext;
    }));
    return { slides: slides };
  }

  /* ══════════════════════════════════════════════════════════════
     FASE 3 — Prompts de estructura por tipo de contenido
     ══════════════════════════════════════════════════════════════ */

  const STRUCTURE_PROMPTS = {

    /* ── 1. OFERTA / PROMO ─────────────────────────────────────── */
    promo: {
      slide_hero: function (product, headline) {
        return [
          "Pure white #FFFFFF background, completely flat, no gradients.",
          product + " photorealistic studio photo, centered in lower 60%, floating with very subtle soft shadow beneath.",
          "Soft diffused studio lighting, gentle rim light on product edges.",
          'Dark gray #1D1D1F thin sans-serif text "' + headline + '" in upper 20%, wide letter-spacing, centered.',
          'Very small #86868B text "GO APPLE" at very top center.',
          "75% negative space. Apple.com product page style. Ultra clean.",
          "No borders, no frames, no icons, no decorations, no extra text, no font names visible.",
        ].join(" ");
      },
      slide_price: function (headline, subtext) {
        return [
          "Soft white-to-light-gray gradient background, subtle studio lighting from above, same premium feel as Apple.com pricing page.",
          'Very large dark gray #1D1D1F ultra-thin sans-serif text "' + headline + '" centered vertically, wide letter-spacing, clean rendering.',
          subtext ? 'Smaller #86868B thin text "' + subtext + '" below the price, same thin weight.' : "",
          'Very small #86868B text "GO APPLE" at very top center.',
          "Only typography, no product, no images, no phone, no device, no icons.",
          "Ultra minimal, premium, elegant. Soft ambient lighting. No borders, no frames, no decorations, no font names visible.",
        ].filter(Boolean).join(" ");
      },
    },

    /* ── 2. PRODUCTO DESTACADO ─────────────────────────────────── */
    product: {
      slide_hero: function (product, headline) {
        return [
          "Pure white #FFFFFF background, completely flat.",
          product + " photorealistic studio render, centered, floating, soft shadow beneath.",
          'Dark gray #1D1D1F thin sans-serif text "' + headline + '" upper area, wide letter-spacing.',
          'Very small #86868B text "GO APPLE" top center.',
          "Apple.com hero product shot. 70% negative space. Ultra minimal.",
          "No borders, no icons, no decorations, no extra text, no font names visible.",
        ].join(" ");
      },
    },

    /* ── 3. CARRUSEL INFORMATIVO ───────────────────────────────── */
    carousel_info: {
      slide_content: function (product, headline, subtext) {
        return [
          "Pure white #FFFFFF background, completely flat.",
          product ? product + " photorealistic render, small, in lower right corner, 25% of frame." : "",
          'Dark gray #1D1D1F sans-serif text "' + headline + '" left-aligned in upper 40%, large.',
          subtext ? 'Smaller #515154 text "' + subtext + '" below headline.' : "",
          'Very small #86868B text "GO APPLE" top center.',
          "Clean editorial layout. Apple style. No borders, no icons, no decorations, no font names visible.",
        ].filter(Boolean).join(" ");
      },
    },

    /* ── 4. BRANDING / ENGAGEMENT ──────────────────────────────── */
    branding: {
      slide_text: function (headline, subtext) {
        return [
          "Pure black #000000 background, completely flat.",
          'White thin sans-serif text "' + headline + '" centered, large, wide letter-spacing.',
          subtext ? 'Smaller white text "' + subtext + '" below, 70% opacity.' : "",
          'Very small #86868B text "GO APPLE" top center.',
          "Apple Keynote typography slide. Dramatic. Minimal. Premium.",
          "No images, no product, no borders, no icons, no decorations, no font names visible.",
        ].filter(Boolean).join(" ");
      },
    },
  };

  /** Ajusta post_type y slide_count según el copy real (más confiable que solo Vision). */
  function refineAnalysisFromCopy(copyText, analysis) {
    var refined = Object.assign({}, analysis);
    var text = (copyText || "").toLowerCase();
    if (!text.trim()) return refined;

    var hasPrice = /\$[\d.,]+/.test(text) || /cuotas?|efectivo|transfer/i.test(text);
    var slideLabels = (copyText.match(/^slide\s*\d+\s*:/gim) || []).length;
    if (slideLabels > 0) refined.slide_count = slideLabels;

    if (hasPrice) {
      refined.post_type = "promo";
      refined.has_price = true;
      return refined;
    }

    if (slideLabels >= 3) {
      if (/pov:|se te cae|crack|todos nos pas|rompecabezas|proteg|seguro/i.test(text)) {
        refined.post_type = "branding";
      } else {
        refined.post_type = "carousel_info";
      }
      return refined;
    }

    if (/iphone|ipad|macbook|mac\b|airpods|apple watch/i.test(text)) {
      refined.post_type = "product";
      var prod = text.match(/(iphone\s*\d+\s*(pro\s*max|pro|plus|mini)?|ipad|macbook|airpods)/i);
      if (prod) refined.product_detected = prod[0].trim();
    }

    return refined;
  }

  function buildIdeogramPrompt(slide, analysis) {
    const headline = truncateForImage(slide.headline, 6);
    const subtext = truncateForImage(slide.subtext, 8);
    const product = analysis.product_detected +
      (analysis.product_color ? " " + analysis.product_color : "");

    var prompt;
    var type = analysis.post_type;

    if (type === "promo") {
      if (slide.slide_type === "price" || slide.slide_type === "cta") {
        prompt = STRUCTURE_PROMPTS.promo.slide_price(headline, subtext);
      } else {
        prompt = STRUCTURE_PROMPTS.promo.slide_hero(product, headline);
      }
    } else if (type === "product") {
      prompt = STRUCTURE_PROMPTS.product.slide_hero(product, headline);
    } else if (type === "carousel_info") {
      prompt = STRUCTURE_PROMPTS.carousel_info.slide_content(product, headline, subtext);
    } else if (type === "branding") {
      prompt = STRUCTURE_PROMPTS.branding.slide_text(headline, subtext);
    } else {
      prompt = STRUCTURE_PROMPTS.product.slide_hero(product, headline);
    }

    console.log("[CreativosEngine][FASE_3] [" + type + "/" + slide.slide_type + "] Texto:", headline, "|", subtext);
    console.log("[CreativosEngine][FASE_3] Prompt completo:", prompt);
    return prompt;
  }

  /* ══════════════════════════════════════════════════════════════
     FASE 4 — Generar imagen con Ideogram 3.0
     ══════════════════════════════════════════════════════════════ */

  async function generateImage(slide, analysis, ideogramKey) {
    console.log("[CreativosEngine][FASE_4] Generando imagen slide " + slide.slide_index + "…");

    var prompt = buildIdeogramPrompt(slide, analysis);

    var apiResp = await fetch("/api/ideogram/v1/ideogram-v3/generate", {
      method: "POST",
      headers: {
        "Api-Key": ideogramKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: prompt,
        rendering_speed: "QUALITY",
        aspect_ratio: "1x1",
        magic_prompt: "OFF",
        style_type: "REALISTIC",
        num_images: 1,
      }),
    });

    if (!apiResp.ok) {
      var errBody = await apiResp.json().catch(function () { return {}; });
      throw new Error(
        errBody.message || errBody.detail || errBody.error || "Ideogram " + apiResp.status
      );
    }

    var data = await apiResp.json();
    var imageUrl = data.data?.[0]?.url;
    if (!imageUrl) throw new Error("Ideogram returned no image URL");

    console.log("[CreativosEngine][FASE_4] Imagen generada, descargando…");

    try {
      var dlResp = await fetchWithTimeout(
        fetch("/api/fetch-media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: imageUrl }),
        }),
        30000
      );
      var dl = await dlResp.json();
      return dl.dataUri || imageUrl;
    } catch (e) {
      console.warn("[CreativosEngine][FASE_4] Download fallback to URL:", e.message);
      return imageUrl;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     CAROUSEL — Renderizar con plantilla HTML existente
     ══════════════════════════════════════════════════════════════ */

  async function generateCarouselWithTemplate(copyResult, analysis) {
    console.log("[CreativosEngine][CAROUSEL] Usando plantilla HTML para carrusel de " + copyResult.slides.length + " slides");

    const brand = { name: "GO APPLE" };
    const results = [];

    for (var i = 0; i < copyResult.slides.length; i++) {
      const slide = copyResult.slides[i];
      try {
        var slideType = "content";
        if (slide.slide_type === "hero" && i === 0) slideType = "hero";
        if (slide.slide_type === "cta") slideType = "cta";

        var slideText = slide.headline;
        if (slide.subtext) slideText += "\n" + slide.subtext;

        if (typeof renderSlideFromTemplate !== "function") {
          throw new Error("renderSlideFromTemplate no disponible");
        }

        var dataUri = await renderSlideFromTemplate(
          brand,
          slideText,
          slideType,
          i,
          copyResult.slides.length
        );

        results.push({ index: i, dataUri: dataUri, error: false });
        console.log("[CreativosEngine][CAROUSEL] Slide " + (i + 1) + " renderizada OK");
      } catch (e) {
        console.error("[CreativosEngine][CAROUSEL] Slide " + i + " error:", e.message);
        results.push({ index: i, dataUri: null, error: true, errorMsg: e.message });
      }
    }

    return results;
  }

  /* ══════════════════════════════════════════════════════════════
     ORQUESTADOR — processCreativo
     ══════════════════════════════════════════════════════════════ */

  async function processCreativo(creativo, cfg, progressCb) {
    var log = function (msg) {
      console.log("[CreativosEngine]", msg);
      if (progressCb) progressCb(msg);
    };

    if (!IMAGE_GENERATION_ENABLED) {
      log("Generación de imágenes IA desactivada — usá diseño manual.");
      return creativo;
    }

    var openaiKey = cfg.openaiKey;
    var ideogramKey = cfg.ideogramKey;

    if (!ideogramKey) throw new Error("Falta API key de Ideogram en configuración.");
    if (!openaiKey) throw new Error("Falta API key de OpenAI en configuración.");

    var refImages = creativo.mediaUrls || [];
    var refImage = refImages[0] || null;

    // FASE 1
    log("Fase 1: Analizando referencia (" + refImages.length + " imagen(es))…");
    var analysis;
    if (refImage) {
      var imagesToAnalyze = refImages.length > 1 ? refImages : refImage;
      analysis = await analyzeReference(imagesToAnalyze, openaiKey);
    } else {
      analysis = { ...ANALYSIS_DEFAULTS };
    }

    if (refImages.length > 1 && analysis.slide_count < refImages.length) {
      analysis.slide_count = refImages.length;
      if (analysis.post_type === "product") {
        analysis.post_type = "carousel_info";
      }
    }

    // FASE 2 — Extraer headlines del copy existente (NO reemplazar el copy)
    var existingCopy = creativo.copy || "";
    log("Fase 2: Extrayendo headlines del copy existente…");
    var copyResult;
    if (existingCopy.trim()) {
      copyResult = await extractSlidesFromCopy(existingCopy, analysis);
      analysis = refineAnalysisFromCopy(existingCopy, analysis);
    } else {
      copyResult = await generateCopy(analysis, "", openaiKey);
      creativo.copy = copyResult.slides
        .map(function (s) {
          return "Slide " + (s.slide_index + 1) + ": " + s.headline + (s.subtext ? " — " + s.subtext : "");
        })
        .join("\n");
    }

    log("Preset: " + analysis.post_type + " · " + copyResult.slides.length + " slide(s)");

    // FASE 3 + 4
    var totalSlides = copyResult.slides.length;
    log("Fase 3-4: Generando " + totalSlides + " imagen(es) con Ideogram…");

    var generateSlide = async function (slide) {
      try {
        log("  Slide " + (slide.slide_index + 1) + "/" + totalSlides + ": " + slide.headline);
        var dataUri = await generateImage(slide, analysis, ideogramKey);
        return { index: slide.slide_index, dataUri: dataUri, error: false };
      } catch (e) {
        console.error("[CreativosEngine] Slide " + slide.slide_index + " failed:", e.message);
        log("  Slide " + (slide.slide_index + 1) + " error: " + e.message);
        return { index: slide.slide_index, dataUri: null, error: true, errorMsg: e.message };
      }
    };

    var results;
    if (totalSlides > 1) {
      results = await Promise.all(copyResult.slides.map(generateSlide));
    } else {
      results = [await generateSlide(copyResult.slides[0])];
    }

    results.sort(function (a, b) { return a.index - b.index; });

    var generatedImages = [];
    var errors = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].error || !results[i].dataUri) {
        errors.push("Slide " + (results[i].index + 1) + ": " + (results[i].errorMsg || "sin imagen"));
      } else {
        try {
          if (typeof resizeImageDataUri === "function" && results[i].dataUri.startsWith("data:")) {
            generatedImages.push(await resizeImageDataUri(results[i].dataUri, 1080));
          } else {
            generatedImages.push(results[i].dataUri);
          }
        } catch (e) {
          generatedImages.push(results[i].dataUri);
        }
      }
    }

    if (generatedImages.length > 0) {
      if (typeof saveGeneratedImages === "function") {
        await saveGeneratedImages(creativo.id, generatedImages);
      }
      creativo.hasGeneratedImages = true;
      creativo.generatedImageCount = generatedImages.length;
      creativo.resultImageUrl = "idb";
      log(generatedImages.length + " imagen(es) generada(s) con éxito.");
    }

    if (errors.length > 0) {
      creativo.notes = (creativo.notes ? creativo.notes + " | " : "") + errors.join("; ");
    }

    creativo.status = generatedImages.length > 0 ? "generado" : "copy_listo";
    creativo.updatedAt = new Date().toISOString();
    creativo._analysis = analysis;

    return creativo;
  }

  /* ══════════════════════════════════════════════════════════════
     REGEN — Solo regenerar imágenes (sin tocar copy)
     ══════════════════════════════════════════════════════════════ */

  async function regenImages(creativo, cfg, progressCb) {
    var log = function (msg) {
      console.log("[CreativosEngine]", msg);
      if (progressCb) progressCb(msg);
    };

    if (!IMAGE_GENERATION_ENABLED) {
      log("Generación de imágenes IA desactivada — usá diseño manual.");
      return creativo;
    }

    var openaiKey = cfg.openaiKey;
    var ideogramKey = cfg.ideogramKey;

    if (!ideogramKey) throw new Error("Falta API key de Ideogram.");
    if (!openaiKey) throw new Error("Falta API key de OpenAI.");

    var refImages = creativo.mediaUrls || [];
    var refImage = refImages[0] || null;

    log("Analizando referencia (" + refImages.length + " imagen(es))…");
    var analysis;
    if (refImage) {
      var imagesToAnalyze = refImages.length > 1 ? refImages : refImage;
      analysis = await analyzeReference(imagesToAnalyze, openaiKey);
    } else {
      analysis = { ...ANALYSIS_DEFAULTS };
    }

    if (refImages.length > 1 && analysis.slide_count < refImages.length) {
      analysis.slide_count = refImages.length;
      if (analysis.post_type === "product") {
        analysis.post_type = "carousel_info";
      }
    }

    var existingCopy = creativo.copy || "";
    log("Extrayendo headlines del copy…");
    var copyResult;
    if (existingCopy.trim()) {
      copyResult = await extractSlidesFromCopy(existingCopy, analysis);
      analysis = refineAnalysisFromCopy(existingCopy, analysis);
    } else {
      copyResult = await generateCopy(analysis, "", openaiKey);
    }

    log("Preset: " + analysis.post_type + " · " + copyResult.slides.length + " slide(s)");

    var totalSlides = copyResult.slides.length;
    log("Generando " + totalSlides + " imagen(es) con Ideogram…");

    var generateSlide = async function (slide) {
      try {
        log("  Slide " + (slide.slide_index + 1) + "/" + totalSlides + ": " + slide.headline);
        var dataUri = await generateImage(slide, analysis, ideogramKey);
        return { index: slide.slide_index, dataUri: dataUri, error: false };
      } catch (e) {
        console.error("[CreativosEngine] Slide " + slide.slide_index + " failed:", e.message);
        return { index: slide.slide_index, dataUri: null, error: true, errorMsg: e.message };
      }
    };

    var results;
    if (totalSlides > 1) {
      results = await Promise.all(copyResult.slides.map(generateSlide));
    } else {
      results = [await generateSlide(copyResult.slides[0])];
    }

    results.sort(function (a, b) { return a.index - b.index; });

    var generatedImages = [];
    for (var i = 0; i < results.length; i++) {
      if (!results[i].error && results[i].dataUri) {
        try {
          if (typeof resizeImageDataUri === "function" && results[i].dataUri.startsWith("data:")) {
            generatedImages.push(await resizeImageDataUri(results[i].dataUri, 1080));
          } else {
            generatedImages.push(results[i].dataUri);
          }
        } catch (e) {
          generatedImages.push(results[i].dataUri);
        }
      }
    }

    if (generatedImages.length > 0) {
      if (typeof saveGeneratedImages === "function") {
        await saveGeneratedImages(creativo.id, generatedImages);
      }
      creativo.hasGeneratedImages = true;
      creativo.generatedImageCount = generatedImages.length;
      creativo.resultImageUrl = "idb";
      creativo.status = "generado";
      creativo.updatedAt = new Date().toISOString();
      log(generatedImages.length + " imagen(es) re-generada(s).");
    } else {
      log("No se generaron imágenes.");
    }

    return creativo;
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════ */

  window.CreativosEngine = {
    analyzeReference: analyzeReference,
    generateCopy: generateCopy,
    buildIdeogramPrompt: buildIdeogramPrompt,
    generateImage: generateImage,
    processCreativo: processCreativo,
    regenImages: regenImages,
    truncateForImage: truncateForImage,
    IMAGE_PRESETS: ANALYSIS_DEFAULTS,
    IMAGE_GENERATION_ENABLED: IMAGE_GENERATION_ENABLED,
  };

  console.log("[CreativosEngine] Motor cargado. Imágenes IA:", IMAGE_GENERATION_ENABLED ? "ON" : "OFF (manual)");
})();
