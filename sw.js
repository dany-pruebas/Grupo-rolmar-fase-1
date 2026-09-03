// Service worker de Grupo Rolmar
// Se encarga de recibir las notificaciones push y mostrarlas,
// y de abrir la app cuando el cliente toca la notificación.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------- Recibir una notificación push ----------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Grupo Rolmar', body: event.data ? event.data.text() : 'Tienes una actualización' };
  }

  const title = data.title || 'Grupo Rolmar';
  const options = {
    body: data.body || '',
    icon: data.icon || '/cliente/icon-192.png',
    badge: data.badge || '/cliente/icon-192.png',
    data: {
      url: data.url || '/cliente/'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------- Click en la notificación: abrir o enfocar la app ----------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/cliente/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/cliente/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
