import dotenv from 'dotenv';
import axios from 'axios';
import cron from 'node-cron';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const CAT_API_URL = 'https://api.thecatapi.com/v1/images/search';
const BARKLE_API_URL = 'https://barkle.chat/api';
const CHANNEL_ID = process.env.CHANNEL_ID;

const catApiKey = process.env.CAT_API_KEY;
const barkleApiToken = process.env.BARKLE_API_TOKEN;

if (!barkleApiToken) {
  console.error('BARKLE_API_TOKEN is not set in the .env file');
  process.exit(1);
}

const barkleAxios = axios.create({
  baseURL: BARKLE_API_URL,
  headers: {
    'Authorization': `Bearer ${barkleApiToken}`,
    'Content-Type': 'application/json',
  },
});

async function getCatImage() {
  try {
    const response = await axios.get(CAT_API_URL, {
      headers: { 'x-api-key': catApiKey }
    });
    return response.data[0].url;
  } catch (error) {
    console.error('Error fetching cat image:', error);
    return null;
  }
}

async function uploadImageToBarkle(imageUrl) {
  try {
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(imageResponse.data, 'binary');

    const form = new FormData();
    form.append('file', buffer, {
      filename: 'cat.jpg',
      contentType: imageResponse.headers['content-type'],
    });

    const response = await barkleAxios.post('drive/files/create', form, {
      headers: {
        ...form.getHeaders(),
        'Content-Type': 'multipart/form-data',
      },
    });

    return response.data.id;
  } catch (error) {
    console.error('Error uploading image to Barkle:', error);
    if (error.response) {
      console.error('Server responded with:', error.response.status, error.response.statusText);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error setting up request:', error.message);
    }
    return null;
  }
}

async function postToBarkle(imageUrl, replyId = null) {
  try {
    const fileId = await uploadImageToBarkle(imageUrl);
    if (!fileId) throw new Error('Failed to upload image');

    const noteParams = {
      text: 'Here\'s your cat!',
      fileIds: [fileId],
      visibility: 'public',
      channelId: CHANNEL_ID
    };

    if (replyId) {
      noteParams.replyId = replyId;
    }

    await barkleAxios.post('notes/create', noteParams);
    console.log('Posted cat image to Barkle');
  } catch (error) {
    console.error('Error posting to Barkle:', error);
  }
}

async function handleMentionNotification(notification) {
  if (notification.type === 'mention' && notification.note.text.toLowerCase().includes('gimme')) {
    const catImageUrl = await getCatImage();
    if (catImageUrl) {
      await postToBarkle(catImageUrl, notification.note.id);
    }
  }
}

async function checkNotifications() {
  try {
    const response = await barkleAxios.post('i/notifications', {
      limit: 5,
      includeTypes: ['mention'],
      unreadOnly: true,
    });

    const notifications = response.data;

    for (const notification of notifications) {
      await handleMentionNotification(notification);
    }

    // Mark all notifications as read after processing
    if (notifications.length > 0) {
      await barkleAxios.post('notifications/mark-all-as-read');
      console.log(`Processed and marked ${notifications.length} notifications as read`);
    }
  } catch (error) {
    console.error('Error checking notifications:', error);
  }
}

// Schedule hourly cat post
cron.schedule('0 * * * *', async () => {
  const catImageUrl = await getCatImage();
  if (catImageUrl) {
    await postToBarkle(catImageUrl);
  }
});

// Check for notifications every 15 seconds
setInterval(checkNotifications, 15000);

console.log('Cat Barkle Bot is running!');