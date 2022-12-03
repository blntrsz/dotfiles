local ensure_packer = function()
  local fn = vim.fn
  local install_path = fn.stdpath("data") .. "/site/pack/packer/start/packer.nvim"
  if fn.empty(fn.glob(install_path)) > 0 then
    fn.system({ "git", "clone", "--depth", "1", "https://github.com/wbthomason/packer.nvim", install_path })
    vim.cmd([[packadd packer.nvim]])
    return true
  end
  return false
end

local packer_bootstrap = ensure_packer()

return require("packer").startup(function(use)
  use("wbthomason/packer.nvim")

  -- LSP
  use({
    "williamboman/mason.nvim",
    config = require("mason").setup(),
  })
  use({
    "williamboman/mason-lspconfig.nvim",
    config = require("mason-lspconfig").setup({
      automatic_installation = true,
    }),
  })
  use("neovim/nvim-lspconfig")
  use({
    "glepnir/lspsaga.nvim",
    branch = "main",
    config = function()
      local saga = require("lspsaga")

      saga.init_lsp_saga({
        -- your configuration
      })
    end,
  })
  use({
    "ray-x/lsp_signature.nvim",
    config = require("mason-lspconfig").setup(),
  })

  use({
    "nvim-telescope/telescope.nvim",
    tag = "0.1.0",
    requires = { { "nvim-lua/plenary.nvim" } },
  })
  use({
    "nvim-treesitter/nvim-treesitter",
    run = ":TSUpdate",
    config = require("nvim-treesitter.configs").setup({
      ensure_installed = {
        "lua",
        "markdown",
        "html",
        "css",
        "javascript",
        "typescript",
        "tsx",
        "prisma",
        "json",
        "svelte",
        "scss",
        "c",
        "python",
        "pug",
        "php",
        "java",
        "astro",
        "vue",
        "dockerfile",
        "graphql",
        "yaml",
        "toml",
      },
      highlight = {
        enable = true,
      },
      rainbow = {
        enable = true,
        extended_mode = false,
      },
      autotag = {
        enable = true,
      },
      indent = { enable = true },
      textobjects = {
        select = {
          enable = true,
          lookahead = true,
          keymaps = {
            ["af"] = "@function.outer",
            ["if"] = "@function.inner",
            ["ac"] = "@class.outer",
            ["ic"] = { query = "@class.inner", desc = "Select inner part of a class region" },
          },
          selection_modes = {
            ["@parameter.outer"] = "v",
            ["@function.outer"] = "V",
            ["@class.outer"] = "<c-v>",
          },
          include_surrounding_whitespace = true,
        },
        swap = {
          enable = true,
          swap_next = {
            ["<leader>a"] = "@parameter.inner",
          },
          swap_previous = {
            ["<leader>A"] = "@parameter.inner",
          },
        },
        move = {
          enable = true,
          set_jumps = true,
          goto_next_start = {
            ["]m"] = "@function.outer",
            ["]]"] = "@class.outer",
          },
          goto_next_end = {
            ["]M"] = "@function.outer",
            ["]["] = "@class.outer",
          },
          goto_previous_start = {
            ["[m"] = "@function.outer",
            ["[["] = "@class.outer",
          },
          goto_previous_end = {
            ["[M"] = "@function.outer",
            ["[]"] = "@class.outer",
          },
        },
      },
    }),
  })
  use("nvim-treesitter/nvim-treesitter-textobjects")
  use("mfussenegger/nvim-dap")
  use("nvim-treesitter/nvim-treesitter-context")
  use({
    "numToStr/Comment.nvim",
    config = require("Comment").setup(),
  })
  use({
    "windwp/nvim-autopairs",
    config = require("nvim-autopairs").setup(),
  })
  use({
    "simrat39/symbols-outline.nvim",
    config = require("symbols-outline").setup(),
  })

  -- cmp
  use("hrsh7th/cmp-nvim-lsp")
  use("hrsh7th/cmp-buffer")
  use("hrsh7th/cmp-path")
  use("hrsh7th/cmp-cmdline")
  use("hrsh7th/nvim-cmp")

  use "rafamadriz/friendly-snippets"
  use({
    "L3MON4D3/LuaSnip",
    tag = "v<CurrentMajor>.*",
    config = require("luasnip.loaders.from_vscode").lazy_load(),
  })
  use("saadparwaiz1/cmp_luasnip")

  -- git
  use("sindrets/diffview.nvim")
  use({
    "TimUntersberger/neogit",
    requires = {
      "nvim-lua/plenary.nvim",
      "sindrets/diffview.nvim",
    },
    config = require("neogit").setup({
      integrations = {
        diffview = true,
      },
    }),
  })
  use({
    "lewis6991/gitsigns.nvim",
    config = require("gitsigns").setup(),
  })
  use({
    "dinhhuy258/git.nvim",
    config = require("git").setup({
      default_mappings = true, -- NOTE: `quit_blame` and `blame_commit` are still merged to the keymaps even if `default_mappings = false`

      keymaps = {
        -- Open blame window
        blame = "<Leader>gb",
        -- Close blame window
        quit_blame = "q",
        -- Open blame commit
        blame_commit = "<CR>",
        -- Open file/folder in git repository
        browse = "<Leader>go",
        -- Open pull request of the current branch
        open_pull_request = "<Leader>gp",
        -- Create a pull request with the target branch is set in the `target_branch` option
        create_pull_request = "<Leader>gn",
        -- Opens a new diff that compares against the current index
        diff = "<Leader>gd",
        -- Close git diff
        diff_close = "<Leader>gD",
        -- Revert to the specific commit
        revert = "<Leader>gr",
        -- Revert the current file to the specific commit
        revert_file = "<Leader>gR",
      },
      -- Default target branch when create a pull request
      target_branch = "master",
    }),
  })

  use("ThePrimeagen/harpoon")
  use({
    "catppuccin/nvim",
    as = "catppuccin",
    config = function()
      require("catppuccin").setup({
        flavour = "macchiato", -- mocha, macchiato, frappe, latte
      })
    end,
  })

  -- Prettier & Eslint
  use("jose-elias-alvarez/null-ls.nvim")

  use({
    "folke/todo-comments.nvim",
    requires = "nvim-lua/plenary.nvim",
    config = function()
      require("todo-comments").setup()
    end,
  })
  use({
    "sudormrfbin/cheatsheet.nvim",

    requires = {
      { "nvim-telescope/telescope.nvim" },
      { "nvim-lua/popup.nvim" },
      { "nvim-lua/plenary.nvim" },
    },
  })

  use({
    "folke/neodev.nvim",
    config = function()
      require("neodev").setup()
    end,
  })
  use({
    "kylechui/nvim-surround",
    config = function()
      require("nvim-surround").setup()
    end,
  })
  use("dstein64/vim-startuptime")

  use({
    "nvim-neotest/neotest",
    requires = {
      "nvim-lua/plenary.nvim",
      "nvim-treesitter/nvim-treesitter",
      "antoinemadec/FixCursorHold.nvim",
    },
  })

  -- Automatically set up your configuration after cloning packer.nvim
  -- Put this at the end after all plugins
  if packer_bootstrap then
    require("packer").sync()
  end
end)
