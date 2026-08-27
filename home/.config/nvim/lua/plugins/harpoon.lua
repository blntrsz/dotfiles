return {
  {
    "theprimeagen/harpoon",
    dependencies = { "nvim-lua/plenary.nvim" },
    keys = {
      { "<leader>ha", "<cmd>lua require('harpoon.mark').add_file()<cr>",        desc = "Harpoon add mark" },
      { "<leader>hh", "<cmd>lua require('harpoon.ui').toggle_quick_menu()<cr>", desc = "Harpoon quick menu" },
      { "<leader>1",  "<cmd>lua require('harpoon.ui').nav_file(1)<cr>",         desc = "Harpoon nav file 1" },
      { "<leader>2",  "<cmd>lua require('harpoon.ui').nav_file(2)<cr>",         desc = "Harpoon nav file 2" },
      { "<leader>3",  "<cmd>lua require('harpoon.ui').nav_file(3)<cr>",         desc = "Harpoon nav file 3" },
      { "<leader>4",  "<cmd>lua require('harpoon.ui').nav_file(4)<cr>",         desc = "Harpoon nav file 4" },
    },
  },
}
