# Bravo Futevôlei

Sistema exclusivo da equipe da escola para cadastro de alunos e controle de mensalidades. Não há acesso, criação de conta ou reservas por alunos.

O cadastro reúne nome, telefone com DDD, plano, valor com centavos, próximo vencimento, situação e observações. Use **Inativo** para manter o histórico de quem passou pela escola. O painel permite buscar alunos e filtrar vencimentos. Os totais são valores previstos dos planos, não recebimentos confirmados. Ao receber uma mensalidade, atualize o próximo vencimento no cadastro.

## Executar

Requer Node.js 18 ou superior. Sem dependências externas para instalar.

Configure `ADMIN_PASSWORD` com pelo menos 12 caracteres por um mecanismo seguro do ambiente e execute `npm start`. A porta padrão é 3000 (`PORT` permite alterar). Configure `DATA_DIR` fora do checkout para armazenar `data.json`. O diretório precisa de armazenamento persistente em produção. Não guarde senhas no repositório.

## Avisos automáticos por WhatsApp

A integração preparada usa WhatsApp Business Platform (Cloud API da Meta). O envio vem **desligado** e requer uma conta de envio, número remetente e modelo de mensagem aprovado. Ter apenas o aplicativo WhatsApp Business no celular não configura essa integração.

Variáveis necessárias no processo do servidor:

- `WHATSAPP_ACCESS_TOKEN`: token da conta (segredo, nunca registrar em logs).
- `WHATSAPP_PHONE_NUMBER_ID`: identificador numérico do número remetente, não o telefone.
- `WHATSAPP_TEMPLATE_NAME`: nome do modelo aprovado.
- `WHATSAPP_GRAPH_VERSION`: versão Graph API suportada pela conta, no formato `vNN.N`.
- `WHATSAPP_TEMPLATE_LANGUAGE`: idioma do modelo; padrão `pt_BR`.
- `WHATSAPP_REMINDERS_ENABLED=true`: ativação explícita, somente depois de configurar a conta.

O modelo deve ter três parâmetros de texto no corpo, nesta ordem: nome, vencimento em DD/MM/AAAA e valor em reais. Exemplo para cadastrar/aprovar na Meta:

> Olá, {{1}}! A mensalidade da Bravo Futevôlei no valor de {{3}} venceu em {{2}}. Se já realizou o pagamento, fale com a equipe para atualizarmos seu cadastro.

O servidor verifica ao iniciar e a cada hora. A partir do dia seguinte ao vencimento, envia um aviso para cada aluno **Ativo**, usando o fuso de São Paulo. Telefones nacionais com DDD recebem o código 55. Não há envio para alunos inativos, experimentais ou números inválidos. A ativação também considera mensalidades já vencidas; revise os cadastros antes de ligar.

O registro persistente em `data.json` impede repetir o aviso para o mesmo aluno e vencimento. Aceitação pela API não confirma entrega ao destinatário. Falhas e resultados incertos não são repetidos automaticamente; exigem revisão. Uma nova data vencida permite um novo aviso. O painel mostra a configuração e os totais de resultados. Os registros ficam disponíveis para a equipe em `GET /api/admin/reminders`, após autenticação.

Mantenha o processo ativo e use apenas uma instância do servidor com esse arquivo de dados. O serviço pode ter custos da hospedagem e do WhatsApp. Uma hospedagem que suspende o processo não executa os avisos enquanto estiver suspensa. Não há confirmação automática de pagamento: vencimentos precisam ser atualizados pela equipe. Não há integração de envio real validada sem a conta e suas configurações.

## Verificação

`node --test` executa os testes da automação com provedor simulado, sem mensagens reais. `node --check server.js` e `node --check public/app.js` verificam a sintaxe. O fluxo administrativo também foi validado no Chromium com dados temporários: login, cadastro, edição, centavos, vencimento, inativos e persistência.
