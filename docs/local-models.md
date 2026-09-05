# Use a local model in Gyro

1. Install [Ollama](https://ollama.com/download/mac) and open it. If you use its
   command-line installation, start the service with `ollama serve`.
2. In a terminal, add a model with `ollama pull <model>`. For a small download
   suitable for checking the connection, use `ollama pull qwen3:0.6b` (about
   522 MB). Choose a larger coding model when your Mac has enough memory.
3. Open **Settings → Providers** in Gyro and click **Refresh models** beside
   Ollama. Gyro discovers installed models and selects the first one if your
   previous selection is unavailable.
4. Choose an Ollama model in the chat model picker and send a message.

After adding another model, click **Refresh models** again. You do not need an
API key or a Gyro restart. Model downloads are managed by Ollama.

If Gyro says the runtime is unavailable, start Ollama. If it says a model is
required, pull a model and refresh. A local model may take time to load; Gyro
allows up to three minutes for a complete response, while connection checks
remain short.

Gyro accepts only loopback HTTP Ollama endpoints and does not follow redirects.
Models that advertise tool support can use governed Gyro tools. Other models
are chat-only. Inference can use substantial CPU, GPU, and memory depending on
the model and hardware; the model runtime is separate from Gyro's idle app work.

For the CLI:

```sh
gyro config enable-provider ollama
gyro run --profile ollama --model qwen3:0.6b "Explain this project"
```
