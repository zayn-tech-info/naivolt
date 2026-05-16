const { Expo } = require('expo-server-sdk');

const expo = new Expo();

async function sendPushNotification(pushToken, { title, body, data = {} }) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) return;
  try {
    const chunks = expo.chunkPushNotifications([
      { to: pushToken, sound: 'default', title, body, data },
    ]);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[Push]', err.message);
  }
}

module.exports = { sendPushNotification };
