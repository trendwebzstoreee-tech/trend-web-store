TREND WEB STORE V2 — QUICK SETUP (TERMUX)

IMPORTANT
- This is a new project package. Do not delete your current trend_web_store_new folder.
- Your existing .env and any existing product data are NOT included in this ZIP.
- Keep your current project as a backup. Copy your existing .env into this project folder before starting.
- Existing product data may need to be re-entered in the new Admin Panel; do not delete the old folder until you confirm the new store works.

FEATURES IN THIS BUILD
- Responsive black/white/red ecommerce storefront.
- Categories: Shoes, Sneakers, Watches, Slippers & Sandals; admin can add more categories such as Gadgets.
- Homepage slideshow advertisements controlled by Admin Panel.
- Product detail page with variants, variant-specific photos, sizes and stock fields.
- Cart and wishlist saved in the browser.
- WhatsApp order message includes product, selected color, size, quantity, price and product link.
- Admin product/category/banner/store-settings management.
- Phone gallery image upload in Admin Panel.

TERMUX SETUP
1. Extract this ZIP to a new folder in Termux home, for example ~/trend_web_store_v2.
2. Copy your existing private .env file from ~/trend_web_store_new/.env into ~/trend_web_store_v2/.env.
   Do not share or upload .env.
3. In Termux run:
   cd ~/trend_web_store_v2
   npm install
   npm start
4. Open the storefront: http://127.0.0.1:3000
5. Open Admin Panel: http://127.0.0.1:3000/admin
6. Sign in using the ADMIN_PASSWORD already configured in your .env.

If your old .env has SESSION_SECRET shorter than 32 characters or ADMIN_PASSWORD shorter than 12 characters, the server will not start; set suitable values locally in .env.

NOTES
- This build stores data in JSON files under data/ and uploaded images under uploads/. Back up both folders.
- It is intended for local testing. Before public production hosting, use HTTPS, secure cookies, a persistent session store, proper backups, and reliable persistent image storage.
- WhatsApp click-to-chat opens a prepared message; the customer must press Send. It does not automatically attach a photo or confirm payment.
