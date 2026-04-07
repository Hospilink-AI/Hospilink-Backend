const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");


// Create S3 client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});


// Upload file to S3
exports.uploadToS3 = async (buffer, key, mimeType) => {
    try {

        const command = new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: mimeType
        });

        await s3.send(command);

        return key; // store S3 key in DB

    } catch (error) {
        console.error("S3 Upload Error:", error);
        throw new Error("Storage service error");
    }
};


// Delete file from S3
exports.deleteFromS3 = async (key) => {
    try {

        const command = new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key
        });

        await s3.send(command);

    } catch (error) {
        console.error("S3 Delete Error:", error);
        throw new Error("Storage service error");
    }
};


// Generate PreSigned URL (15 minutes)
exports.generatePreSignedURL = async (key) => {
    try {

        const command = new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key
        });

        return await getSignedUrl(s3, command, {
            expiresIn: 900 // 15 minutes (900 seconds)
        });

    } catch (error) {
        console.error("S3 PreSigned URL Error:", error);
        throw new Error("Storage service error");
    }
};