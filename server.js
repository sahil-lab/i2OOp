const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();
const OpenAI = require('openai');
const { put, del, list } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;
let photosCollection;

async function connectToMongoDB() {
    try {
        await client.connect();
        console.log('Connected to MongoDB');
        db = client.db('photo-description-app');
        photosCollection = db.collection('photos');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
    }
}

// Connect to MongoDB when the server starts
connectToMongoDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), 'uploads');
try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (error) {
    console.warn('Warning: Could not create uploads directory. This is expected in serverless environments.', error);
    // Continue execution - in serverless environments we'll handle files differently
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ storage: storage });

// AI-powered object detection function using OpenAI Vision API
async function detectObjectsInImage(imagePath) {
    try {
        // Read the image file and convert to base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Analyze this image and identify all visible objects in it. Be comprehensive and specific. For each object, include:\n\n1. The name of the object\n2. A confidence score between 0 and 1\n3. A brief description of the object's appearance\n4. The category it belongs to (e.g., furniture, electronic, food, clothing, etc.)\n\nRespond ONLY with a valid JSON array containing objects with this exact structure:\n[{\"name\": \"object_name\", \"confidence\": 0.95, \"description\": \"brief description\", \"category\": \"object_category\"}]\n\nDo not include any explanations, markdown formatting, or text outside of the JSON array."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`,
                                detail: "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1500
        });

        // Ensure we got a valid response
        if (!response || !response.choices || !response.choices[0] || !response.choices[0].message) {
            console.error('Invalid OpenAI response structure:', response);
            return getFallbackObjects();
        }

        const content = response.choices[0].message.content;

        // Make sure content is not empty
        if (!content || typeof content !== 'string') {
            console.error('Empty or invalid content in OpenAI response');
            return getFallbackObjects();
        }

        // Clean the response and try to parse JSON
        let cleanContent = content.trim();

        // Remove any markdown formatting if present
        if (cleanContent.startsWith('```json')) {
            cleanContent = cleanContent.replace(/```json\s*/, '').replace(/```\s*$/, '');
        } else if (cleanContent.startsWith('```')) {
            cleanContent = cleanContent.replace(/```\s*/, '').replace(/```\s*$/, '');
        }

        try {
            const objects = JSON.parse(cleanContent);
            console.log("Detected objects:", JSON.stringify(objects, null, 2));

            // Validate that objects is an array
            if (!Array.isArray(objects)) {
                console.error('OpenAI response is not an array:', objects);
                return getFallbackObjects();
            }

            // Validate each object has required properties
            const validObjects = objects.filter(obj =>
                obj && typeof obj === 'object' &&
                obj.name && typeof obj.name === 'string' &&
                typeof obj.confidence === 'number'
            );

            return validObjects;
        } catch (parseError) {
            console.error('Error parsing OpenAI response:', parseError);
            console.log('Raw response content:', content);
            // Fallback: extract object names from text response
            return extractObjectsFromText(content);
        }

    } catch (error) {
        console.error('Error with OpenAI Vision API:', error);
        // Fallback to basic object detection
        return getFallbackObjects();
    }
}

// Helper function to extract objects from text response if JSON parsing fails
function extractObjectsFromText(text) {
    const commonObjects = [
        'person', 'people', 'man', 'woman', 'child', 'baby',
        'car', 'vehicle', 'bicycle', 'motorcycle', 'bus', 'truck',
        'tree', 'plant', 'flower', 'grass', 'leaf',
        'building', 'house', 'window', 'door', 'wall',
        'table', 'chair', 'sofa', 'bed', 'desk',
        'phone', 'computer', 'laptop', 'screen', 'keyboard',
        'book', 'paper', 'pen', 'pencil',
        'cup', 'glass', 'bottle', 'plate', 'bowl',
        'food', 'fruit', 'apple', 'banana', 'orange',
        'dog', 'cat', 'bird', 'animal',
        'sky', 'cloud', 'sun', 'moon', 'star',
        'water', 'river', 'lake', 'ocean', 'beach',
        'mountain', 'hill', 'rock', 'stone',
        'road', 'street', 'path', 'bridge',
        'light', 'lamp', 'candle', 'fire',
        'bag', 'backpack', 'suitcase', 'box',
        'clock', 'watch', 'mirror', 'picture'
    ];

    const foundObjects = [];
    const lowerText = text.toLowerCase();

    commonObjects.forEach(obj => {
        if (lowerText.includes(obj)) {
            foundObjects.push({
                name: obj,
                confidence: 0.8,
                description: `Detected ${obj} in the image`
            });
        }
    });

    return foundObjects.slice(0, 8); // Limit to 8 objects
}

// Fallback function for when AI detection fails
function getFallbackObjects() {
    const fallbackObjects = [
        { name: 'unknown_object_1', confidence: 0.5, description: 'Object detected but not identified' },
        { name: 'unknown_object_2', confidence: 0.5, description: 'Object detected but not identified' }
    ];
    return fallbackObjects;
}

// Routes

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload and process photo
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const photoId = uuidv4();
        const filename = req.file.filename;
        const fileKey = `photos/${photoId}`;

        // Upload file to Vercel Blob
        const uploadResult = await uploadFileToBlob(req.file, fileKey);

        // Get the local path or Vercel Blob URL for AI processing
        const imagePath = uploadResult.isLocal
            ? path.join(process.cwd(), 'uploads', filename)
            : req.file.path; // Use the local temp path before it's deleted

        try {
            // Use AI to detect objects in the image
            const detectedObjects = await detectObjectsInImage(imagePath);

            // Create a description from detected objects
            const objectNames = detectedObjects.map(obj => obj.name).join(', ');
            const description = detectedObjects.length > 0
                ? `Objects detected: ${objectNames}`
                : 'No specific objects detected';

            // Create metadata with detected objects
            const metadata = {
                id: photoId,
                originalName: req.file.originalname,
                filename: uploadResult.key,
                fileUrl: uploadResult.url,
                isLocalStorage: uploadResult.isLocal,
                size: req.file.size,
                mimetype: req.file.mimetype,
                description: description,
                detectedObjects: detectedObjects,
                objectCategories: [...new Set(detectedObjects.map(obj => obj.category || 'Uncategorized'))],
                analysisTimestamp: new Date().toISOString(),
                uploadedAt: new Date().toISOString()
            };

            // Store in MongoDB
            try {
                const result = await photosCollection.insertOne({
                    _id: photoId,
                    filename: uploadResult.key,
                    fileUrl: uploadResult.url,
                    isLocalStorage: uploadResult.isLocal,
                    description: description,
                    metadata: metadata,
                    created_at: new Date()
                });

                return res.json({
                    success: true,
                    data: metadata
                });
            } catch (dbError) {
                console.error('Database error:', dbError);
                return res.status(500).json({ success: false, error: 'Database error' });
            }
        } catch (aiError) {
            console.error('Error processing image with AI:', aiError);

            // Fallback to basic metadata if AI processing fails
            const metadata = {
                id: photoId,
                originalName: req.file.originalname,
                filename: fileKey,
                fileUrl: uploadResult.url,
                isLocalStorage: uploadResult.isLocal,
                size: req.file.size,
                mimetype: req.file.mimetype,
                description: 'Image uploaded successfully',
                detectedObjects: [],
                objectCategories: [],
                analysisTimestamp: null,
                uploadedAt: new Date().toISOString(),
                error: 'Object detection failed'
            };

            try {
                const result = await photosCollection.insertOne({
                    _id: photoId,
                    filename: fileKey,
                    fileUrl: uploadResult.url,
                    isLocalStorage: uploadResult.isLocal,
                    description: metadata.description,
                    metadata: metadata,
                    created_at: new Date()
                });

                return res.json({
                    success: true,
                    data: metadata
                });
            } catch (dbError) {
                console.error('Database error:', dbError);
                return res.status(500).json({ success: false, error: 'Database error' });
            }
        }
    } catch (error) {
        console.error('Unexpected error in upload endpoint:', error);
        return res.status(500).json({ success: false, error: 'Server error: ' + (error.message || 'Unknown error') });
    }
});

// Get all photos
app.get('/api/photos', async (req, res) => {
    try {
        const photos = await photosCollection.find({})
            .sort({ created_at: -1 })
            .toArray();

        res.json(photos.map(photo => ({
            id: photo._id,
            filename: photo.filename,
            fileUrl: photo.fileUrl || `/uploads/${photo.filename}`,
            isLocalStorage: photo.isLocalStorage || true,
            description: photo.description,
            metadata: photo.metadata,
            created_at: photo.created_at
        })));
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Get specific photo
app.get('/api/photos/:id', async (req, res) => {
    const photoId = req.params.id;

    try {
        const photo = await photosCollection.findOne({ _id: photoId });

        if (!photo) {
            return res.status(404).json({ success: false, error: 'Photo not found' });
        }

        res.json({
            id: photo._id,
            filename: photo.filename,
            fileUrl: photo.fileUrl || `/uploads/${photo.filename}`,
            isLocalStorage: photo.isLocalStorage || true,
            description: photo.description,
            metadata: photo.metadata,
            created_at: photo.created_at
        });
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Serve uploaded images
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(process.cwd(), 'uploads', filename);

    try {
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            console.error(`File not found: ${filePath}`);
            res.status(404).json({ success: false, error: 'Image not found' });
        }
    } catch (error) {
        console.error('Error serving image:', error);
        res.status(500).json({ success: false, error: 'Error serving image' });
    }
});

// Delete photo
app.delete('/api/photos/:id', async (req, res) => {
    const photoId = req.params.id;

    try {
        // First get the photo to delete the file
        const photo = await photosCollection.findOne({ _id: photoId });

        if (photo) {
            // Delete file from storage (Vercel Blob or local)
            try {
                if (photo.isLocalStorage) {
                    // Delete from local filesystem
                    const filePath = path.join(process.cwd(), 'uploads', photo.filename);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } else {
                    // Delete from Vercel Blob
                    await deleteFileFromBlob(photo.fileUrl, photo.isLocalStorage);
                }
            } catch (fsError) {
                console.warn('Warning: Could not delete file:', fsError);
                // Continue execution - file might not exist
            }
        }

        // Delete from database
        const result = await photosCollection.deleteOne({ _id: photoId });

        res.json({ success: true, deletedId: photoId });
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Make uploads directory accessible
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Function to upload file to Vercel Blob
async function uploadFileToBlob(file, filename) {
    try {
        // If we're in development mode and don't have Blob token, fallback to local storage
        if (process.env.NODE_ENV !== 'production' && !process.env.BLOB_READ_WRITE_TOKEN) {
            console.log('Vercel Blob token not found, using local filesystem in development mode');
            return {
                isLocal: true,
                key: file.filename,
                url: `/uploads/${file.filename}`
            };
        }

        // Read file data
        const fileData = fs.readFileSync(file.path);
        const fileExtension = path.extname(file.originalname);
        const blobName = `${filename}${fileExtension}`;

        console.log(`Uploading ${blobName} to Vercel Blob...`);

        // Upload to Vercel Blob
        const blob = await put(blobName, fileData, {
            access: 'public',
            contentType: file.mimetype
        });

        console.log(`Upload successful: ${blob.url}`);

        // Delete local file after successful upload
        try {
            fs.unlinkSync(file.path);
        } catch (unlinkError) {
            console.warn('Could not delete local file after Blob upload:', unlinkError);
        }

        return {
            isLocal: false,
            key: blobName,
            url: blob.url
        };
    } catch (error) {
        console.error('Error uploading to Vercel Blob:', error);
        // Fallback to local file if Blob upload fails
        return {
            isLocal: true,
            key: file.filename,
            url: `/uploads/${file.filename}`,
            error: error.message
        };
    }
}

// Function to delete file from Vercel Blob
async function deleteFileFromBlob(url, isLocal) {
    try {
        // If it's stored locally, delete from local filesystem
        if (isLocal) {
            const filename = url.split('/').pop();
            const filePath = path.join(process.cwd(), 'uploads', filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return true;
        }

        // Delete from Vercel Blob
        await del(url);
        return true;
    } catch (error) {
        console.error('Error deleting file from Vercel Blob:', error);
        return false;
    }
}

// Start server with port fallback mechanism
const startServer = () => {
    // Find an available port
    const findAvailablePort = (port) => {
        return new Promise((resolve, reject) => {
            const server = require('http').createServer();

            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    // Port is in use, try the next one
                    console.log(`Port ${port} is busy, trying port ${port + 1}...`);
                    resolve(findAvailablePort(port + 1));
                } else {
                    reject(err);
                }
            });

            server.on('listening', () => {
                // Port is available, close the server and return the port
                server.close();
                resolve(port);
            });

            server.listen(port);
        });
    };

    // Find an available port starting from PORT and then start the app
    findAvailablePort(PORT)
        .then((availablePort) => {
            app.listen(availablePort, () => {
                console.log(`Server running on http://localhost:${availablePort}`);
            });
        })
        .catch((err) => {
            console.error('Error finding available port:', err);
        });
};

// Only start the server if not in a serverless environment (like Vercel)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    startServer();
}

// Graceful shutdown
process.on('SIGINT', async () => {
    try {
        await client.close();
        console.log('MongoDB connection closed.');
        process.exit(0);
    } catch (error) {
        console.error('Error closing MongoDB connection:', error);
        process.exit(1);
    }
});
