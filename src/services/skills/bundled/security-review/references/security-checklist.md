# Security Review Checklist

- What new capability is granted, to whom, and under what approval path?
- Can untrusted input reach a shell, file write, network request, or privilege boundary?
- Are path validation, allowlists, and workspace boundaries enforced before execution?
- Could the change leak secrets, transcripts, tokens, or local file contents?
- Which tests or static checks prove the protection still works?
