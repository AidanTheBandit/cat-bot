import dotenv from 'dotenv';
import axios from 'axios';
import cron from 'node-cron';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const CAT_API_URL = 'https://api.thecatapi.com/v1/images/search';
const BARKLE_API_URL = 'https://barkle.chat/api';
const CHANNEL_ID = process.env.CHANNEL_ID;
const SUBSCRIBER_LIST_FILE = path.join(__dirname, 'list.txt');

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

async function readSubscriberList() {
  try {
    const data = await fs.readFile(SUBSCRIBER_LIST_FILE, 'utf8');
    return data.split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, create it
      await fs.writeFile(SUBSCRIBER_LIST_FILE, '');
      return [];
    }
    console.error('Error reading subscriber list:', error);
    return [];
  }
}

async function writeSubscriberList(subscribers) {
  try {
    await fs.writeFile(SUBSCRIBER_LIST_FILE, subscribers.join('\n'));
  } catch (error) {
    console.error('Error writing subscriber list:', error);
  }
}

async function addSubscriber(username) {
  const subscribers = await readSubscriberList();
  if (!subscribers.includes(username)) {
    subscribers.push(username);
    await writeSubscriberList(subscribers);
    console.log(`Added ${username} to subscribers`);
  }
}

async function removeSubscriber(username) {
  const subscribers = await readSubscriberList();
  const updatedSubscribers = subscribers.filter(sub => sub !== username);
  if (subscribers.length !== updatedSubscribers.length) {
    await writeSubscriberList(updatedSubscribers);
    console.log(`Removed ${username} from subscribers`);
  }
}

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

async function postToBarkle(imageUrl, replyId = null, text = null) {
  try {
    const noteParams = {
      text: text || 'Here\'s your cat!',
      visibility: 'public',
      channelId: CHANNEL_ID
    };

    if (imageUrl) {
      const fileId = await uploadImageToBarkle(imageUrl);
      if (!fileId) throw new Error('Failed to upload image');
      noteParams.fileIds = [fileId];
    }

    if (replyId) {
      noteParams.replyId = replyId;
    }

    const response = await barkleAxios.post('notes/create', noteParams);
    console.log('Posted to Barkle:', response.data);
    return response.data;  // Return just the data part of the response
  } catch (error) {
    console.error('Error posting to Barkle:', error);
    throw error;  // Re-throw the error to be caught by the caller
  }
}

async function getRandomText() {
  try {
    const data = await fs.readFile(path.join(__dirname, 'texts.txt'), 'utf8');
    const lines = data.split('\n').filter(line => line.trim() !== '');
    return lines[Math.floor(Math.random() * lines.length)];
  } catch (error) {
    console.error('Error reading random text:', error);
    return 'Here\'s your cat!';
  }
}

async function handleMentionNotification(notification) {
  const mentionText = notification.note.text.toLowerCase();
  const username = notification.user.username;

  console.log(`Processing mention from ${username}: "${mentionText}"`);

  // Extract the actual command by removing the bot's mention
  const botUsername = 'gimmecats'; // Replace with your bot's actual username
  const command = mentionText.replace(`@${botUsername}`, '').trim();

  console.log(`Extracted command: "${command}"`);

  if (command.includes('subscribe') || command.includes('sub') || command.includes('join')) {
    console.log('Handling subscription request');
    await addSubscriber(username);
    await barkleAxios.post('notes/create', {
      text: `@${username} You've been subscribed to hourly cat posts!`,
      visibility: 'public',
      channelId: CHANNEL_ID,
      replyId: notification.note.id
    });
  } else if (command.includes('unsubscribe') || command.includes('unsub') || command.includes('leave')) {
    console.log('Handling unsubscription request');
    await removeSubscriber(username);
    await barkleAxios.post('notes/create', {
      text: `@${username} You've been unsubscribed from hourly cat posts.`,
      visibility: 'public',
      channelId: CHANNEL_ID,
      replyId: notification.note.id
    });
  } else if (command.includes('gimme')) {
    console.log('Handling "gimme" request');
    const catImageUrl = await getCatImage();
    if (catImageUrl) {
      const randomText = await getRandomText();
      await postToBarkle(catImageUrl, notification.note.id, `@${username} ${randomText}`);
    }
  } else {
    console.log('No specific action taken for this mention');
    // Optionally, you can respond with help text here
    await barkleAxios.post('notes/create', {
      text: `@${username} You can use 'subscribe' to get hourly cats, 'unsubscribe' to stop, or 'gimme' for an immediate cat!`,
      visibility: 'public',
      channelId: CHANNEL_ID,
      replyId: notification.note.id
    });
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

async function postHourlyCat() {
  console.log('Posting hourly cat');
  try {
    const catImageUrl = await getCatImage();
    if (!catImageUrl) {
      throw new Error('Failed to get a cat image URL');
    }

    const randomText = await getRandomText();
    const postResponse = await postToBarkle(catImageUrl, null, randomText);
    
    if (!postResponse || !postResponse.id) {
      throw new Error('Failed to get note ID from the cat post response');
    }

    console.log('Cat post successful, ID:', postResponse.id);

    // Mention subscribers in a reply
    const subscribers = await readSubscriberList();
    if (subscribers.length > 0) {
      const mentionText = subscribers.map(sub => `@${sub}`).join(' ') + ' Here\'s your subscribed cat post!';
      await postToBarkle(null, postResponse.id, mentionText);
      console.log(`Mentioned ${subscribers.length} subscribers in a reply`);
    } else {
      console.log('No subscribers to mention');
    }
  } catch (error) {
    console.error('Error in postHourlyCat:', error);
  }
}

// Schedule hourly cat post
cron.schedule('0 * * * *', postHourlyCat);

// Check for notifications every 15 seconds
setInterval(checkNotifications, 15000);

console.log('Cat Barkle Bot is running!');

console.log('Initiating first cat post...');
postHourlyCat().then(() => {
  console.log('First cat post completed');
}).catch((error) => {
  console.error('Error in first cat post:', error);
});