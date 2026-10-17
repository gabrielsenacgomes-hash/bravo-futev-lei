# Bravo Futevôlei

Aplicação web para cadastro de alunos, controle de horários e reservas de aula.

## Contas e reservas dos alunos

A equipe cadastra o aluno no painel com nome, WhatsApp, e-mail, status e vencimento do plano. O aluno abre o link da área do aluno e cria a conta usando o mesmo e-mail e WhatsApp registrados pela escola; ele define uma senha com pelo menos 10 caracteres. As senhas são armazenadas com hash seguro no servidor.

Alunos com status **Ativo** e plano ainda válido podem reservar. Alunos inativos ou com o plano vencido continuam podendo entrar para ver o aviso, mas não podem consultar horários disponíveis nem fazer novas reservas. Na área do aluno só aparecem horários que a equipe deixou abertos e que ainda têm vagas. Ainda não há recuperação automática de senha; se esquecer, o aluno deve falar com a equipe da Bravo.

## Rodar no computador

Precisa ter Node.js 18 ou mais recente instalado. No PowerShell, dentro desta pasta:

```powershell
$env:ADMIN_PASSWORD = 'escolha-uma-senha-com-12-caracteres-ou-mais'
node server.js
```

Abra `http://localhost:3000`. A área do aluno fica em `http://localhost:3000/?aluno`; é esse link que deve ser compartilhado depois que o site estiver publicado. Os dados ficam em `data.json` nesta pasta.

## Publicar na internet com Render

O repositório precisa ser conectado a um Web Service Node no Render. Use `npm install` como comando de build e `node server.js` como comando de inicialização; configure `ADMIN_PASSWORD` com pelo menos 12 caracteres. A área do aluno usa a URL do serviço com `/?aluno`.

O aplicativo grava cadastros, contas, planos e reservas em `data.json`. Configure um disco persistente e a variável `DATA_DIR` apontando para o caminho de montagem do disco antes de operar com dados reais. O serviço Render atualmente está no plano Free, cujo sistema de arquivos é temporário; consulte os planos e custos do Render antes de fazer upgrade.
