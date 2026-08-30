vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

vim.keymap.set("n", "<C-j>", "<cmd>cnext<CR>zz")
vim.keymap.set("n", "<C-k>", "<cmd>cprev<CR>zz")
vim.keymap.set("n", "<C-c>", "<cmd>cclose<CR>")
vim.keymap.set("n", "<leader>c", function()
  local filepath = vim.fn.expand("%:.")
  vim.fn.setreg("+", filepath)
  vim.notify("Copied filepath: " .. filepath)
end, { desc = "Copy relative filepath to clipboard" })
vim.keymap.set("n", "<leader>o", "<cmd>copen<CR>")

vim.keymap.set("v", ">", ">gv")
vim.keymap.set("v", "<", "<gv")

vim.keymap.set("n", "<leader>/", function()
  require("config.multigrep").live_multi_grep()
end)
