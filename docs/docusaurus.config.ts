import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'photo-lib',
  tagline: 'A local photo catalog with semantic search and subject tags',
  favicon: 'img/logo.svg',

  future: {
    v4: true,
  },

  // GitHub Pages (.github/workflows/docs.yml). Locally the site is served under the same path,
  // e.g. http://localhost:3000/photo-lab/.
  url: 'https://jbencina.github.io',
  baseUrl: '/photo-lab/',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'photo-lib',
      logo: {
        alt: 'photo-lib',
        src: 'img/logo.svg',
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {to: '/cli', label: 'CLI', position: 'left'},
        {to: '/api', label: 'API', position: 'left'},
        {href: 'https://github.com/jbencina/photo-lab', label: 'GitHub', position: 'right'},
      ],
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'ini', 'powershell', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
