const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model chain - 2.5 Pro for maximum accuracy
const MODELS = [
  { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },  // Most accurate
  { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },  // Reliable backup
];

// Generation config - optimized for accuracy
const GENERATION_CONFIG = {
  temperature: 0.2,       // Very low for maximum accuracy
  topP: 0.9,              // More focused
  topK: 32,               // More focused
  maxOutputTokens: 4096   // Enough for response
};

const PROMPT = `You are an expert wildlife biologist, ornithologist, and taxonomist with decades of field experience. 

FIRST, ASSESS IMAGE QUALITY:
Before attempting identification, evaluate if the image is suitable:
1. Is the resolution sufficient to see identifying features clearly?
2. Is the animal significantly obstructed (by foliage, objects, blur)?
3. Is the animal too distant to identify reliably?
4. Is the image too dark, overexposed, or blurry?

If the image quality is insufficient, return:
{
  "identified": false,
  "reason": "low_resolution" | "obstructed" | "too_distant" | "poor_quality" | "no_animal",
  "qualityIssue": "Specific description of what's wrong (e.g., 'Image resolution too low to see plumage details', 'Animal partially hidden behind branches', 'Subject is too far away to distinguish field marks')",
  "suggestion": "Helpful tip (e.g., 'Please upload a higher resolution image', 'Try a photo with clearer view of the animal')"
}

IF IMAGE QUALITY IS ACCEPTABLE, ANALYZE CAREFULLY:
Look at:
1. Body shape, size proportions, and posture
2. Bill/beak shape, size, and color
3. Leg length, color, and structure
4. Wing pattern, length, and shape
5. Tail shape and length
6. Plumage/fur colors, patterns, and markings
7. Eye color, size, and ring patterns
8. Any distinctive field marks

CRITICAL ACCURACY RULES:
- Only identify to the taxonomic level you are 90%+ CONFIDENT about
- If you can confidently identify the species but NOT the subspecies, leave subspecies as null
- If you can only confidently identify the genus, use "Genus sp." format
- Do NOT guess - accuracy is more important than specificity
- Consider similar species that could be confused - rule them out explicitly

Return JSON only:
{
  "identified": true,
  "identificationLevel": "subspecies/species/genus/family",
  "confidence": 0.95,
  "commonName": "Common Name (use most specific name you're confident about)",
  "scientificName": "Full scientific name to the level you're confident (e.g. 'Genus species' or just 'Genus sp.' if species uncertain)",
  "taxonomy": {
    "kingdom": "Animalia",
    "phylum": "",
    "class": "",
    "order": "",
    "family": "",
    "subfamily": "",
    "genus": "",
    "species": "null if not confident enough to determine",
    "subspecies": "null if not confident enough to determine, or 'monotypic' if species has no subspecies"
  },
  "confidenceLevels": {
    "family": 0.99,
    "genus": 0.95,
    "species": 0.85,
    "subspecies": 0.60
  },
  "similarSpeciesRuledOut": [
    "Species Name 1 - reason why ruled out (e.g., different bill shape, lacks eye ring)",
    "Species Name 2 - reason why ruled out",
    "Species Name 3 - reason why ruled out"
  ],
  "identificationReasoning": "Explain what features you could see clearly and why you stopped at this taxonomic level",
  "sex": "Male/Female/Unknown - only if clearly visible indicators",
  "lifeStage": "Adult/Juvenile/Immature/Unknown",
  "morph": "color morph/phase if clearly applicable (melanistic, leucistic, erythristic, etc.) or null",
  "migratoryStatus": "For birds: Resident/Winter Visitor/Summer Visitor/Passage Migrant/Vagrant - based on location and time of year, or null for non-birds (used for analysis only, not displayed)",
  "description": "detailed identifying features you can see",
  "geographicRange": "where this species/genus is typically found",
  "iucnStatus": {
    "global": "Global IUCN Red List status: LC (Least Concern) / NT (Near Threatened) / VU (Vulnerable) / EN (Endangered) / CR (Critically Endangered) / EW (Extinct in Wild) / EX (Extinct) / DD (Data Deficient) / NE (Not Evaluated)",
    "local": "Local/national conservation status for the location context if known (e.g., 'Nationally Endangered', 'Protected', 'Locally Threatened'), or null if same as global or unknown"
  }
}

IMPORTANT for similarSpeciesRuledOut:
- List 3-5 species that could be confused with this identification
- For each, explain the key distinguishing feature that ruled it out
- Use common names that users would recognize
- Focus on species found in similar geographic regions

If no animal: {"identified": false, "reason": "no_animal", "qualityIssue": "No animal detected in the image", "suggestion": "Please send a photo containing an animal"}`;

async function identifyAnimal(imageBuffer, mimeType = 'image/jpeg', options = {}) {
  const base64Image = imageBuffer.toString('base64');
  
  // Add location/country context if provided
  let prompt = PROMPT;
  
  // Add identification target if specified
  if (options.identifyTarget) {
    prompt += `\n\n🎯 IDENTIFICATION TARGET:
The user wants you to specifically identify: "${options.identifyTarget}"
Focus on this specific subject in the image. If there are multiple animals, identify only the one matching this description.
If you cannot find what the user described, return: {"identified": false, "reason": "target_not_found", "qualityIssue": "Could not find the specified subject in the image", "suggestion": "Please describe the animal more clearly or send a photo with the subject more visible"}`;
  }
  
  if (options.location || options.country) {
    prompt += `\n\n🌍 GEOGRAPHIC CONTEXT (use to help narrow down identification):`;
    if (options.country) {
      prompt += `\nCountry: ${options.country}`;
    }
    if (options.location) {
      prompt += `\nLocation: ${options.location}`;
    }
    
    // Add current date for migratory bird consideration
    const currentDate = new Date();
    const month = currentDate.toLocaleString('en-US', { month: 'long' });
    const year = currentDate.getFullYear();
    prompt += `\nCurrent Date: ${month} ${year}`;
    
    prompt += `\n\n🦅 MIGRATORY BIRDS CONSIDERATION:
- Consider whether this could be a migratory species passing through or wintering in this location
- For the given location and time of year, consider:
  * Resident species (present year-round)
  * Winter visitors/migrants (typically Oct-Mar in Northern Hemisphere)
  * Summer breeding visitors (typically Apr-Sep in Northern Hemisphere)
  * Passage migrants (during spring Mar-May or autumn Aug-Nov)
- If a species is unlikely to be present at this location during this time of year, mention this in your reasoning
- Migratory status can help narrow down identification between similar species

Use this geographic and temporal information to help identify the species/subspecies, but ONLY if you are confident. Geographic location and season can help narrow down possibilities but should not override visual evidence.`;
  }

  let lastError = null;

  for (const modelInfo of MODELS) {
    // Retry up to 3 times with exponential backoff for quota errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 Trying ${modelInfo.displayName} (attempt ${attempt}/3)...`);
        
        const model = genAI.getGenerativeModel({ 
          model: modelInfo.name,
          generationConfig: GENERATION_CONFIG
        });

      // Add 60 second timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout after 60s')), 60000)
      );

      const result = await Promise.race([
        model.generateContent([
          prompt,
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Image
            }
          }
        ]),
        timeoutPromise
      ]);

      const response = await result.response;
      const text = response.text();

      console.log(`✅ ${modelInfo.displayName} responded`);
      console.log(`   Raw response (first 500 chars):`, text.substring(0, 500));

      // Try to extract JSON - handle markdown code blocks
      let jsonText = text;
      
      // Remove markdown code blocks if present
      if (jsonText.includes('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (jsonText.includes('```')) {
        jsonText = jsonText.replace(/```\n?/g, '');
      }
      
      // Find JSON object
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          
          return {
            success: true,
            data: data,
            model: modelInfo.displayName
          };
        } catch (parseErr) {
          console.log(`   JSON parse error:`, parseErr.message);
          throw new Error('Failed to parse JSON: ' + parseErr.message);
        }
      }

      throw new Error('No valid JSON in response');

    } catch (error) {
      console.log(`❌ ${modelInfo.displayName} failed: ${error.message}`);
      
      // Check for quota/rate limit errors
      const isQuotaError = error.message?.toLowerCase().includes('quota') ||
                          error.message?.toLowerCase().includes('rate') ||
                          error.message?.toLowerCase().includes('429') ||
                          error.message?.toLowerCase().includes('resource exhausted');
      
      if (isQuotaError && attempt < 3) {
        const waitTime = attempt * 20000; // 20s, 40s, 60s
        console.log(`⏳ Quota limit hit. Waiting ${waitTime/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue; // Retry same model
      }
      
      if (error.response) {
        console.log(`   Response status:`, error.response.status);
      }
      lastError = error;
      break; // Move to next model
    }
    }
  }

  // All models failed
  return {
    success: false,
    error: lastError?.message?.includes('quota') || lastError?.message?.includes('Quota')
      ? 'API quota exceeded. Please wait a minute and try again.'
      : (lastError?.message || 'All models failed')
  };
}

module.exports = { identifyAnimal };
