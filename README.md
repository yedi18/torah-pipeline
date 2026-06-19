# תמלול שיעורים · Torah Lecture Transcription

אפליקציית דפדפן סטטית (ללא שרת) לתמלול שיעורים בעברית — הקלטה, העלאת קובץ, או הורדת אודיו מ‑YouTube.
A fully static (no‑server) browser app for transcribing Hebrew lectures — record, upload a file, or download audio from YouTube.

## ✨ יכולות / Features
- 🎙️ **הקלטה** ישירות מהמיקרופון → תמלול
- 📁 **העלאת קובץ** שמע/וידאו → תמלול
- 🔗 **הורדה מ‑YouTube** של האודיו למחשב
- 📜 **היסטוריה** מקומית עם חיפוש, ספירת מילים, וצפייה מלאה
- 🌙 **מצב כהה/בהיר** ו‑🌐 **עברית/אנגלית**
- מנוע תמלול: [**ivrit.ai**](https://www.ivrit.ai) (Whisper) דרך RunPod Serverless

הכל רץ בדפדפן. המפתחות נשמרים מקומית ב‑`localStorage` בלבד ואינם נשלחים לשום מקום מלבד השירותים עצמם (RunPod / RapidAPI).

## 🚀 הפעלה / Run
פשוט פותחים את `index.html` בדפדפן, או מארחים את התיקייה ב‑GitHub Pages.
Just open `index.html`, or host the folder on GitHub Pages.

בכניסה הראשונה — עברו ל‑⚙️ **הגדרות** והזינו את המפתחות (יש מדריך מובנה לכל אחד):
1. **ivrit.ai** — `API Key` + `Endpoint ID` (חובה לתמלול)
2. **RapidAPI** — `X‑RapidAPI‑Key` (אופציונלי, רק להורדת YouTube)

## 🗂️ קבצים / Files
- `index.html` — האפליקציה + הלוגיקה (קריאות ישירות ל‑API מהדפדפן)
- `style.css` — עיצוב (Light/Dark, RTL/LTR)
- `server.js` — שרת Node ישן (אופציונלי; **לא נדרש** לגרסה הסטטית, שמור לשלב עתידי של שכתוב/סיכום עם Claude)

## 🔜 בהמשך / Roadmap
שכתוב, הגהה וסיכום אוטומטי עם Claude — שלב זה ידרוש פרוקסי/שרת קטן כי Anthropic/OpenAI חוסמות קריאות ישירות מהדפדפן.
