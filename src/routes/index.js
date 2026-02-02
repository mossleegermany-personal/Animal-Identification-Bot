const express = require('express');
const multer = require('multer');
const { identifyAnimal, identifyAnimalFromUrl } = require('../services/geminiService');

const router = express.Router();

// Configure multer for memory storage (we'll pass buffer to Gemini)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 20MB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Animal Identification Bot',
    model: 'Gemini 2.5 Pro with Thinking',
    timestamp: new Date().toISOString()
  });
});

// Identify animal from uploaded image
router.post('/identify', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No image file provided. Please upload an image.' 
      });
    }

    // Optional context parameters for better identification
    const options = {
      location: req.body.location || null,
      habitat: req.body.habitat || null,
      additionalNotes: req.body.notes || null
    };

    console.log(`Processing image: ${req.file.originalname} (${req.file.size} bytes)`);
    
    const result = await identifyAnimal(req.file.buffer, req.file.mimetype, options);
    
    res.json(result);
  } catch (error) {
    console.error('Identification error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Identify animal from image URL
router.post('/identify-url', async (req, res) => {
  try {
    const { imageUrl, location, habitat, notes } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'No image URL provided.' 
      });
    }

    const options = {
      location: location || null,
      habitat: habitat || null,
      additionalNotes: notes || null
    };

    console.log(`Processing image from URL: ${imageUrl}`);
    
    const result = await identifyAnimalFromUrl(imageUrl, options);
    
    res.json(result);
  } catch (error) {
    console.error('Identification error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
