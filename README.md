# Bravo Futevôlei

Aplicação web para cadastro de alunos, controle de horários e reservas de aula.

## Rodar no computador

Precisa ter Node.js 18 ou mais recente instalado. No PowerShell, dentro desta pasta:

```powershell
$env:ADMIN_PASSWORD = 'escolha-uma-senha-com-12-caracteres-ou-mais'
node server.js
```

Abra `http://localhost:3000`. A área do aluno fica em `http://localhost:3000/?aluno`; é esse link que deve ser compartilhado depois que o site estiver publicado. Os dados ficam em `data.json` nesta pasta.

## Publicar na internet com Render

O arquivo `render.yaml` já configura o serviço Node, o disco persistente e solicita a senha do painel durante a publicação.

1. Extraia o ZIP e envie o conteúdo da pasta `bravo-futevolei` para a raiz de um repositório no GitHub. Mantenha `render.yaml` na raiz.
2. No Render, escolha **New + → Blueprint** e conecte esse repositório.
3. Quando solicitado, defina `ADMIN_PASSWORD` com uma senha forte de pelo menos 12 caracteres e confirme a criação do serviço.
4. Quando o deploy terminar, abra a URL `onrender.com` exibida no painel. A área dos alunos usa a mesma URL com `/?aluno`.
5. Para usar um domínio próprio, adicione-o em **Settings → Custom Domains** no serviço e copie os registros DNS exibidos para o site onde comprou o domínio.

O serviço precisa de um plano pago para manter o disco com os cadastros e reservas. Não use o plano gratuito para operar a agenda: o sistema de arquivos desse plano é temporário. Consulte o preço apresentado pelo Render antes de confirmar.
