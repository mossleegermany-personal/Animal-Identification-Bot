const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model chain - 2.5 Pro for maximum accuracy
const MODELS = [
  { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },  // Most accurate
  { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },  // Reliable backup
];

// Generation config - optimized for speed
const GENERATION_CONFIG = {
  temperature: 0.4,       // Low for accurate results
  topP: 0.95,             // Default
  topK: 40,               // Default
  maxOutputTokens: 4096   // Enough for response
};

const PROMPT = `You are an expert wildlife biologist and taxonomist. Identify the animal in this image with FULL taxonomic detail.

CRITICAL: You MUST attempt to identify the subspecies. For example:
- Peregrine Falcon has 19 subspecies (anatum, peregrinus, brookei, calidus, etc.)
- Tigers have 6 subspecies (bengalensis, tigris, altaica, etc.)
- Lions have subspecies (leo, melanochaita, etc.)

Analyze visible features like size, coloration, markings, and any geographic clues to determine the most likely subspecies.

Return JSON only:
{
  "identified": true,
  "confidence": 0.95,
  "commonName": "Common Name",
  "scientificName": "Genus species subspecies",
  "taxonomy": {
    "kingdom": "Animalia",
    "phylum": "",
    "class": "",
    "order": "",
    "family": "",
    "subfamily": "",
    "genus": "",
    "species": "",
    "subspecies": "MUST provide subspecies name based on visible features, or 'Unable to determine from image' if truly impossible"
  },
  "subspeciesReasoning": "Explain why you identified this subspecies or why it cannot be determined",
  "sex": "Male/Female/Unknown - explain indicators",
  "lifeStage": "Adult/Juvenile/Immature/Unknown",
  "morph": "color morph/phase if applicable (melanistic, leucistic, erythristic, etc.) or null",
  "description": "detailed identifying features",
  "geographicRange": "where this species/subspecies is typically found",
  "conservationStatus": "IUCN status"
}

If no animal: {"identified": false, "reason": "why"}`;

async function identifyAnimal(imageBuffer, mimeType = 'image/jpeg', options = {}) {
  const base64Image = imageBuffer.toString('base64');
  
  // Add location/country context if provided
  let prompt = PROMPT;
  if (options.location || options.country) {
    prompt += `\n\n🌍 GEOGRAPHIC CONTEXT (CRITICAL for subspecies identification):`;
    if (options.country) {
      prompt += `\nCountry: ${options.country}`;
    }
    if (options.location) {
      prompt += `\nLocation: ${options.location}`;
    }
    prompt += `\n\nUse this geographic information to identify the correct SUBSPECIES. Many species have different subspecies in different regions. For example:
- Tigers in India are Bengal tigers (Panthera tigris tigris)
- Tigers in Russia are Siberian tigers (Panthera tigris altaica)
- Leopards in Africa are African leopards (Panthera pardus pardus)
- Leopards in Asia are different subspecies based on region

PRIORITIZE identifying the subspecies based on this location data.`;
  }

  let lastError = null;

  for (const modelInfo of MODELS) {
    try {
      console.log(`🔄 Trying ${modelInfo.displayName} (${modelInfo.name})...`);
      
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
      console.log(`   Full error:`, error);
      if (error.response) {
        console.log(`   Response status:`, error.response.status);
        console.log(`   Response data:`, error.response.data);
      }
      lastError = error;
      // Continue to next model
    }
  }

  // All models failed
  return {
    success: false,
    error: lastError?.message || 'All models failed'
  };
}

module.exports = { identifyAnimal };
