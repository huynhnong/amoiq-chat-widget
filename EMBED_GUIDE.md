# How to Embed the Chat Widget on Your Website

## Quick Start

Add these two script tags to your HTML page (before the closing `</body>` tag):

```html
<script>
  window.ChatWidgetConfig = {
    tenantId: "your-tenant-id",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

## Complete Example

### Basic HTML Page

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Website</title>
</head>
<body>
    <h1>Welcome to My Website</h1>
    <p>Your content here...</p>

    <!-- Chat Widget Configuration -->
    <script>
      window.ChatWidgetConfig = {
        tenantId: "your-tenant-id",
        position: "bottom-right"
      };
    </script>
    
    <!-- Chat Widget Loader -->
    <script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
</body>
</html>
```

## Configuration Options

### Required
- **`tenantId`** (string): Your unique tenant identifier

### Optional
- **`position`** (string): Widget position on screen
  - `"bottom-right"` (default)
  - `"bottom-left"`
  - `"top-right"`
  - `"top-left"`
- **`baseUrl`** (string): Override widget server URL (default: auto-detected)
- **`siteId`** (string): Optional site identifier for multi-site tenants. If not provided, the widget automatically detects the domain from the current website.

### Example with All Options

```html
<script>
  window.ChatWidgetConfig = {
    tenantId: "my-company-123",
    position: "bottom-right",
    baseUrl: "https://webchat.amoiq.com",  // Optional
    siteId: "site-456"                     // Optional: for multi-site tenants
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

## Integration Examples

### React/Next.js

```jsx
// pages/_app.js or app/layout.tsx
import Script from 'next/script';

export default function MyApp({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <Script id="chat-widget-config" strategy="beforeInteractive">
        {`
          window.ChatWidgetConfig = {
            tenantId: "your-tenant-id",
            position: "bottom-right"
          };
        `}
      </Script>
      <Script 
        src="https://webchat.amoiq.com/widget.v1.0.0.js" 
        strategy="lazyOnload"
      />
    </>
  );
}
```

### WordPress

Add to your theme's `footer.php` (before `</body>`):

```php
<script>
  window.ChatWidgetConfig = {
    tenantId: "<?php echo get_option('chat_widget_tenant_id'); ?>",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

### Shopify

1. Go to **Online Store → Themes → Actions → Edit code**
2. Open `theme.liquid`
3. Add before `</body>`:

```liquid
<script>
  window.ChatWidgetConfig = {
    tenantId: "{{ shop.permanent_domain }}",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

### Wix

1. Go to **Settings → Custom Code**
2. Add code to **Footer**:

```html
<script>
  window.ChatWidgetConfig = {
    tenantId: "your-tenant-id",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

### Squarespace

1. Go to **Settings → Advanced → Code Injection**
2. Add to **Footer**:

```html
<script>
  window.ChatWidgetConfig = {
    tenantId: "your-tenant-id",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

## Testing

1. Replace `"your-tenant-id"` with your actual tenant ID
2. Save and refresh your page
3. You should see a blue chat bubble in the bottom-right corner
4. Click it to open the chat interface

## Troubleshooting

### Widget doesn't appear
- Check browser console for errors
- Verify `tenantId` is set correctly
- Make sure script loads (check Network tab)

### "Invalid configuration" error
- Ensure `tenantId` is provided in `ChatWidgetConfig`
- Check that the config script runs before the widget script

### Widget appears but can't connect
- This is normal if backend API is not set up yet
- Set environment variables in Vercel once backend is ready

## Customization

The widget automatically:
- ✅ Injects itself into the page
- ✅ Creates a floating chat bubble
- ✅ Opens chat in an iframe
- ✅ Handles open/close interactions
- ✅ Works on mobile and desktop

No additional CSS or JavaScript needed!

